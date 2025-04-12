pub mod msg;
pub mod queue;
pub mod state;

use anyhow::{bail, Error};
use cosmwasm_std::{
    entry_point, to_json_binary, Binary, Deps, DepsMut, Env, MessageInfo, Response, SubMsg, Uint128,
};

use amulet_core::admin::AdminRole;
use amulet_cw::{
    admin::{self, Repository as AdminRepository},
    hub::{QueryMsg as HubQueryMsg, VaultMetadata},
};

use self::{
    msg::{
        redeem_on_behalf, ConfigResponse, ExecuteMsg, InstantiateMsg, ProxyAdminMsg, ProxyQueryMsg,
        ProxyUserMsg, QueryMsg, QueueEntriesResponse, QueueEntry, QueueEntryResponse,
    },
    queue::{ReadOnlyRedemptionQueue, RedemptionQueue},
    state::StorageExt as _,
};

#[entry_point]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, Error> {
    admin::init(deps.storage, &info);

    deps.api.addr_validate(&msg.hub_address)?;

    deps.storage.set_hub(&msg.hub_address);

    Ok(Response::default())
}

fn synthetic_for_vault(deps: Deps, hub: &str, vault: &str) -> Result<String, Error> {
    let vault_metadata: VaultMetadata = deps.querier.query_wasm_smart(
        hub,
        &HubQueryMsg::VaultMetadata {
            vault: vault.to_owned(),
        },
    )?;

    Ok(vault_metadata.synthetic)
}

fn vault_reserve_balance(deps: Deps, hub: &str, vault: &str) -> Result<u128, Error> {
    let vault_metadata: VaultMetadata = deps.querier.query_wasm_smart(
        hub,
        &HubQueryMsg::VaultMetadata {
            vault: vault.to_owned(),
        },
    )?;

    Ok(vault_metadata.reserve_balance.u128())
}

pub fn handle_process_head(deps: DepsMut, vault: String) -> Result<Response, Error> {
    deps.api.addr_validate(&vault)?;

    let hub = deps.storage.hub();
    let reserve_balance = vault_reserve_balance(deps.as_ref(), &hub, &vault)?;
    let synthetic = synthetic_for_vault(deps.as_ref(), &hub, &vault)?;

    let mut queue = RedemptionQueue::new(deps.storage, &vault);
    let available_amount = Uint128::new(reserve_balance);

    let (processed, used_amount) = queue.process_head(available_amount)?;

    // NOTE: If no entries are processed, these response attributes will still exist.
    let mut response = Response::default()
        .add_attribute("kind", "process_head")
        .add_attribute("vault", &vault)
        .add_attribute("processed_entries", processed.len().to_string())
        .add_attribute("used_amount", used_amount);

    for (address, amount) in processed {
        let msg = redeem_on_behalf(&hub, &vault, &synthetic, address, amount.u128());
        response = response.add_message(msg);
    }

    Ok(response)
}

pub fn handle_redeem(
    mut deps: DepsMut,
    info: MessageInfo,
    vault: String,
) -> Result<Response, Error> {
    deps.api.addr_validate(&vault)?;

    if info.funds.len() != 1 {
        bail!("Must send exactly one token type");
    }

    let coin = &info.funds[0];
    if coin.amount.is_zero() {
        bail!("Cannot redeem zero amount");
    }

    let hub = deps.storage.hub();
    let synthetic = synthetic_for_vault(deps.as_ref(), &hub, &vault)?;

    if coin.denom != synthetic {
        bail!(
            "Incorrect token: expected {}, got {}",
            synthetic,
            coin.denom
        );
    }

    let process_head_response = handle_process_head(deps.branch(), vault.clone())?;

    let mut queue = RedemptionQueue::new(deps.storage, &vault);
    let index = queue.enqueue(info.sender.as_ref(), coin.amount)?;

    let mut response = Response::default()
        .add_attribute("kind", "redeem")
        .add_attribute("address", &info.sender)
        .add_attribute("vault", &vault)
        .add_attribute("amount", coin.amount)
        .add_attribute("entry_index", index.to_string());

    for msg in process_head_response.messages {
        response = response.add_submessage(msg);
    }

    let vault_metadata: VaultMetadata = deps.querier.query_wasm_smart(
        &hub,
        &HubQueryMsg::VaultMetadata {
            vault: vault.to_owned(),
        },
    )?;
    let reserve_balance = vault_metadata.reserve_balance.u128();
    let available_amount = Uint128::new(reserve_balance);

    // NOTE: Using 1 instead of 0 to accommodate precision errors
    if available_amount > Uint128::one() {
        let (processed, _used_amount) = queue.process_head(available_amount)?;

        if !processed.is_empty() {
            for (address, amount) in processed {
                let msg = redeem_on_behalf(&hub, &vault, &synthetic, address, amount.u128());
                response = response.add_message(msg);
            }
        }
    }

    Ok(response)
}

pub fn handle_cancel_entry(
    deps: DepsMut,
    info: MessageInfo,
    vault: String,
    index: u64,
) -> Result<Response, Error> {
    deps.api.addr_validate(&vault)?;

    let mut queue = RedemptionQueue::new(deps.storage, &vault);

    match queue.get_entry(index) {
        Some(entry) if entry.address == info.sender => {
            let (_, amount) = queue.remove_entry(index)?;

            let hub = deps.storage.hub();
            let synthetic = synthetic_for_vault(deps.as_ref(), &hub, &vault)?;

            let msg = SubMsg::new(cosmwasm_std::BankMsg::Send {
                to_address: info.sender.to_string(),
                amount: vec![cosmwasm_std::coin(amount.u128(), synthetic)],
            });

            Ok(Response::default()
                .add_attribute("kind", "cancel_entry")
                .add_attribute("address", &info.sender)
                .add_attribute("vault", &vault)
                .add_attribute("index", index.to_string())
                .add_attribute("amount", amount)
                .add_submessage(msg))
        }
        Some(_) => {
            bail!("Entry {} does not belong to {}", index, info.sender);
        }
        None => {
            bail!("Entry {} not found", index);
        }
    }
}

pub fn handle_cancel_all(
    deps: DepsMut,
    info: MessageInfo,
    vault: String,
) -> Result<Response, Error> {
    deps.api.addr_validate(&vault)?;

    let mut queue = RedemptionQueue::new(deps.storage, &vault);
    let cancelled = queue.cancel_user_entries(info.sender.as_ref())?;

    if cancelled.is_empty() {
        return Ok(Response::default()
            .add_attribute("kind", "cancel_all")
            .add_attribute("address", &info.sender)
            .add_attribute("vault", &vault)
            .add_attribute("count", "0"));
    }

    // Calculate total amount
    let total_amount: Uint128 = cancelled
        .iter()
        .fold(Uint128::zero(), |acc, (_, amount)| acc + *amount);

    // Return the synthetic tokens to the user
    let hub = deps.storage.hub();
    let synthetic = synthetic_for_vault(deps.as_ref(), &hub, &vault)?;

    let msg = SubMsg::new(cosmwasm_std::BankMsg::Send {
        to_address: info.sender.to_string(),
        amount: vec![cosmwasm_std::coin(total_amount.u128(), synthetic)],
    });

    Ok(Response::default()
        .add_attribute("kind", "cancel_all")
        .add_attribute("address", &info.sender)
        .add_attribute("vault", &vault)
        .add_attribute("count", cancelled.len().to_string())
        .add_attribute("amount", total_amount)
        .add_submessage(msg))
}

pub fn handle_force_cancel_entry(
    _: AdminRole,
    deps: DepsMut,
    vault: String,
    index: u64,
) -> Result<Response, Error> {
    deps.api.addr_validate(&vault)?;

    let mut queue = RedemptionQueue::new(deps.storage, &vault);

    if queue.get_entry(index).is_none() {
        bail!("Entry {} not found", index);
    }

    let (address, amount) = queue.remove_entry(index)?;

    let hub = deps.storage.hub();
    let synthetic = synthetic_for_vault(deps.as_ref(), &hub, &vault)?;

    let msg = SubMsg::new(cosmwasm_std::BankMsg::Send {
        to_address: address.clone(),
        amount: vec![cosmwasm_std::coin(amount.u128(), synthetic)],
    });

    Ok(Response::default()
        .add_attribute("kind", "force_cancel_entry")
        .add_attribute("vault", &vault)
        .add_attribute("index", index.to_string())
        .add_attribute("address", &address)
        .add_attribute("amount", amount)
        .add_submessage(msg))
}

#[entry_point]
pub fn execute(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, Error> {
    match msg {
        ExecuteMsg::Admin(msg) => {
            let cmd = admin::handle_execute_msg(
                deps.api,
                &AdminRepository::new(deps.storage),
                info,
                msg,
            )?;

            admin::handle_cmd(deps.storage, cmd);

            Ok(Response::default())
        }

        ExecuteMsg::ProxyUser(ProxyUserMsg::ProcessHead { vault }) => {
            handle_process_head(deps, vault)
        }

        ExecuteMsg::ProxyUser(ProxyUserMsg::Redeem { vault }) => handle_redeem(deps, info, vault),

        ExecuteMsg::ProxyUser(ProxyUserMsg::CancelEntry { vault, index }) => {
            handle_cancel_entry(deps, info, vault, index)
        }

        ExecuteMsg::ProxyUser(ProxyUserMsg::CancelAll { vault }) => {
            handle_cancel_all(deps, info, vault)
        }

        ExecuteMsg::ProxyAdmin(admin_msg) => {
            let admin_role = admin::get_admin_role(&AdminRepository::new(deps.storage), &info)?;

            match admin_msg {
                ProxyAdminMsg::ForceCancelEntry { vault, index } => {
                    handle_force_cancel_entry(admin_role, deps, vault, index)
                }
            }
        }
    }
}

#[entry_point]
pub fn query(deps: Deps, _: Env, msg: QueryMsg) -> Result<Binary, Error> {
    let binary = match msg {
        QueryMsg::Admin(query) => {
            admin::handle_query_msg(&AdminRepository::new(deps.storage), query)?
        }

        QueryMsg::Proxy(ProxyQueryMsg::Config {}) => to_json_binary(&ConfigResponse {
            hub_address: deps.storage.hub(),
        })?,

        QueryMsg::Proxy(ProxyQueryMsg::AllQueueEntries {
            vault,
            start_index,
            limit,
        }) => {
            deps.api.addr_validate(&vault)?;

            let queue = ReadOnlyRedemptionQueue::new(deps.storage, &vault);
            let entries = queue.get_all_entries(start_index, limit);

            let entries = entries
                .into_iter()
                .map(|entry| QueueEntry {
                    index: entry.index,
                    address: entry.address,
                    amount: entry.amount,
                })
                .collect();

            to_json_binary(&QueueEntriesResponse { entries })?
        }

        QueryMsg::Proxy(ProxyQueryMsg::OwnerQueueEntries {
            vault,
            address,
            start,
            limit,
        }) => {
            deps.api.addr_validate(&vault)?;
            deps.api.addr_validate(&address)?;

            let queue = ReadOnlyRedemptionQueue::new(deps.storage, &vault);
            let entries = queue.get_user_entries(&address, start, limit);

            let entries = entries
                .into_iter()
                .map(|entry| QueueEntry {
                    index: entry.index,
                    address: entry.address,
                    amount: entry.amount,
                })
                .collect();

            to_json_binary(&QueueEntriesResponse { entries })?
        }

        QueryMsg::Proxy(ProxyQueryMsg::QueueEntry { vault, index }) => {
            deps.api.addr_validate(&vault)?;

            let queue = ReadOnlyRedemptionQueue::new(deps.storage, &vault);

            match queue.get_entry(index) {
                Some(entry) => {
                    let (position, amount_in_front) = queue.get_entry_position(index)?;

                    to_json_binary(&QueueEntryResponse {
                        entry: QueueEntry {
                            index: entry.index,
                            address: entry.address,
                            amount: entry.amount,
                        },
                        position_in_queue: position,
                        amount_in_front,
                    })?
                }
                None => bail!("Entry {} not found", index),
            }
        }
    };

    Ok(binary)
}
