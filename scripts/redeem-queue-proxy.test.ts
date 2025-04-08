import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { TestSuite } from "./suite";
import { artifact, readContractFileBytes } from "./utils";
import { StdFee } from "@cosmjs/stargate";
import { coin } from "@cosmjs/proto-signing";
import { ExecuteMsg as MintExecuteMsg } from "../ts/AmuletMint.types";
import {
  StateResponse as VaultStateResponse,
  ClaimableResponse as VaultClaimableResponse,
} from "../ts/AmuletGenericLst.types";
import {
  ExecuteMsg as HubExecuteMsg,
  InstantiateMsg as HubInstantiateMsg,
  PositionResponse,
  VaultMetadata,
} from "../ts/AmuletHub.types";
import {
  InstantiateMsg as DepositProxyInstantiateMsg,
  MetadataResponse,
  DepositAmountResponse,
  ExecuteMsg as DepositProxyExecuteMsg,
} from "../ts/DepositCapProxy.types";
import {
  InstantiateMsg as RedeemProxyInstantiateMsg,
  ExecuteMsg as RedeemProxyExecuteMsg,
  QueueEntriesResponse,
  QueueEntryResponse,
} from "../ts/RedeemQueueProxy.types";
import {
  QueryClient,
  HostClient,
  createFee,
  createQueryClient,
  createHostClient,
  createHostWallet,
  initGenericLstVault,
  toBeWithinN,
} from "./test-helpers";

function sharesValue(vaultState: VaultStateResponse, shares: any): bigint {
  return (
    (BigInt(shares) * BigInt(vaultState.total_deposits)) /
    BigInt(vaultState.total_issued_shares)
  );
}

const TOTAL_DEPOSIT_CAP = 1_000_000_000;
const INDIVIDUAL_DEPOSIT_CAP = 600_000_000;
const TOTAL_MINT_CAP = 1_000_000_000;

let suite: ITestSuite;
let hostQueryClient: QueryClient;
let operatorAddress: string;
let aliceAddress: string;
let bobAddress: string;
let operatorClient: HostClient;
let aliceClient: HostClient;
let bobClient: HostClient;
let vaultCodeId: number;
let mockOracleCodeId: number;
let hubCodeId: number;
let mintCodeId: number;
let depositProxyCodeId: number;
let redeemProxyCodeId: number;
let vaultAddress: string;
let mockOracleAddress: string;
let hubAddress: string;
let mintAddress: string;
let depositProxyAddress: string;
let redeemProxyAddress: string;
let gasFee: StdFee;
let depositAssetDenom: string = "untrn";
let syntheticAssetDenom: string;

describe("Deposit Cap Proxy", () => {
  beforeAll(async () => {
    suite = await TestSuite.create({
      networkOverrides: {
        neutron: {
          genesis_opts: {
            "app_state.interchaintxs.params.msg_submit_tx_max_messages": "16",
            "app_state.feeburner.params.treasury_address":
              // aribitrarily picked testnet address
              "neutron12z4p3g6zjrnlz79znrjef4sxklsnnmpglgzhx2",
          },
        },
      },
    });

    const operatorWallet = await createHostWallet(suite, "demo1");
    const aliceWallet = await createHostWallet(suite, "demo2");
    const bobWallet = await createHostWallet(suite, "demo3");

    operatorAddress = (await operatorWallet.getAccounts())[0].address;
    aliceAddress = (await aliceWallet.getAccounts())[0].address;
    bobAddress = (await bobWallet.getAccounts())[0].address;

    operatorClient = await createHostClient(suite, operatorWallet);
    aliceClient = await createHostClient(suite, aliceWallet);
    bobClient = await createHostClient(suite, bobWallet);

    hostQueryClient = await createQueryClient(suite.getHostRpc());

    gasFee = createFee(suite, 5_000_000);
  });

  afterAll(async () => {
    await suite.cleanup();
  });

  it("should upload the mock-lst-oracle contract byte code", async () => {
    const wasmFilePath = artifact("mock-lst-oracle");
    const wasmBytes = await readContractFileBytes(wasmFilePath);
    const res = await operatorClient.upload(operatorAddress, wasmBytes, gasFee);
    mockOracleCodeId = res.codeId;
  });

  it("should upload the amulet-generic-lst vault contract byte code", async () => {
    const wasmFilePath = artifact("amulet-generic-lst");
    const wasmBytes = await readContractFileBytes(wasmFilePath);
    const res = await operatorClient.upload(operatorAddress, wasmBytes, gasFee);
    vaultCodeId = res.codeId;
  });

  it("should upload the amulet-hub contract byte code", async () => {
    const wasmFilePath = artifact("amulet-hub");
    const wasmBytes = await readContractFileBytes(wasmFilePath);
    const res = await operatorClient.upload(operatorAddress, wasmBytes, gasFee);
    hubCodeId = res.codeId;
  });

  it("should upload the amulet-mint contract byte code", async () => {
    const wasmFilePath = artifact("amulet-mint");
    const wasmBytes = await readContractFileBytes(wasmFilePath);
    const res = await operatorClient.upload(operatorAddress, wasmBytes, gasFee);
    mintCodeId = res.codeId;
  });

  it("should upload the desosit-cap-proxy contract byte code", async () => {
    const wasmFilePath = artifact("deposit-cap-proxy");
    const wasmBytes = await readContractFileBytes(wasmFilePath);
    const res = await operatorClient.upload(operatorAddress, wasmBytes, gasFee);
    depositProxyCodeId = res.codeId;
  });

  it("should upload the redeem-queue-proxy contract byte code", async () => {
    const wasmFilePath = artifact("redeem-queue-proxy");
    const wasmBytes = await readContractFileBytes(wasmFilePath);
    const res = await operatorClient.upload(operatorAddress, wasmBytes, gasFee);
    redeemProxyCodeId = res.codeId;
  });

  it("should deploy the mock-lst-oracle", async () => {
    const res = await operatorClient.instantiate(
      operatorAddress,
      mockOracleCodeId,
      {},
      "mock-lst-oracle",
      gasFee
    );

    mockOracleAddress = res.contractAddress;
  });

  it("should deploy the amulet-generic-lst vault, pretending untrn is an LST", async () => {
    vaultAddress = await initGenericLstVault(
      suite,
      operatorClient,
      vaultCodeId,
      operatorAddress,
      mockOracleAddress,
      "untrn",
      6,
      6
    );
  });

  it("should deploy the amulet-mint", async () => {
    const res = await operatorClient.instantiate(
      operatorAddress,
      mintCodeId,
      {},
      "amulet-mint",
      gasFee
    );

    mintAddress = res.contractAddress;
  });

  it("should deploy the amulet-hub", async () => {
    const msg: HubInstantiateMsg = { synthetic_mint: mintAddress };
    const res = await operatorClient.instantiate(
      operatorAddress,
      hubCodeId,
      msg,
      "amulet-hub",
      gasFee
    );

    hubAddress = res.contractAddress;
  });

  it("should deploy the deposit-cap-proxy", async () => {
    const msg: DepositProxyInstantiateMsg = {
      hub_address: hubAddress,
    };

    const res = await operatorClient.instantiate(
      operatorAddress,
      depositProxyCodeId,
      msg,
      "deposit-cap-proxy",
      gasFee
    );

    depositProxyAddress = res.contractAddress;
  });

  it("should configure deposit-cap-proxy caps for the vault", async () => {
    const msg: DepositProxyExecuteMsg = {
      set_config: {
        vault: vaultAddress,
        total_deposit_cap: String(TOTAL_DEPOSIT_CAP),
        individual_deposit_cap: String(INDIVIDUAL_DEPOSIT_CAP),
        total_mint_cap: String(TOTAL_MINT_CAP),
      },
    };

    await operatorClient.execute(
      operatorAddress,
      depositProxyAddress,
      msg,
      gasFee
    );
  });

  it("should deploy the redeem-queue-proxy", async () => {
    const msg: RedeemProxyInstantiateMsg = {
      hub_address: hubAddress,
    };

    const res = await operatorClient.instantiate(
      operatorAddress,
      redeemProxyCodeId,
      msg,
      "redeem-queue-proxy",
      gasFee
    );

    redeemProxyAddress = res.contractAddress;
  });

  it("should create the amNTRN synthetic", async () => {
    const msg: MintExecuteMsg = {
      create_synthetic: {
        decimals: 6,
        ticker: "amNTRN",
      },
    };

    await operatorClient.execute(operatorAddress, mintAddress, msg, gasFee);

    // Get the synthetic denom
    syntheticAssetDenom = `factory/${mintAddress}/amntrn`;
  });

  it("should whitelist the hub as a minter", async () => {
    const msg: MintExecuteMsg = {
      set_whitelisted: {
        minter: hubAddress,
        whitelisted: true,
      },
    };

    await operatorClient.execute(operatorAddress, mintAddress, msg, gasFee);
  });

  it("should register the vault with the hub and enable deposits/advance", async () => {
    {
      const msg: HubExecuteMsg = {
        register_vault: {
          vault: vaultAddress,
          synthetic: syntheticAssetDenom,
        },
      };

      await operatorClient.execute(operatorAddress, hubAddress, msg, gasFee);
    }
    {
      const msg: HubExecuteMsg = {
        set_deposits_enabled: {
          vault: vaultAddress,
          enabled: true,
        },
      };

      await operatorClient.execute(operatorAddress, hubAddress, msg, gasFee);
    }
    {
      const msg: HubExecuteMsg = {
        set_advance_enabled: {
          vault: vaultAddress,
          enabled: true,
        },
      };

      await operatorClient.execute(operatorAddress, hubAddress, msg, gasFee);
    }
  });

  it("should configure the deposit and mint and redeem proxy for the vault", async () => {
    const msg: HubExecuteMsg = {
      set_proxy_config: {
        vault: vaultAddress,
        deposit: depositProxyAddress,
        mint: depositProxyAddress,
        redeem: redeemProxyAddress,
      },
    };

    await operatorClient.execute(operatorAddress, hubAddress, msg, gasFee);
  });

  it("alice makes the initial deposit via the proxy", async () => {
    const depositAmount = INDIVIDUAL_DEPOSIT_CAP;

    await aliceClient.execute(
      aliceAddress,
      depositProxyAddress,
      { deposit: { vault: vaultAddress } },
      gasFee,
      "",
      [coin(depositAmount, depositAssetDenom)]
    );

    const position: PositionResponse = await operatorClient.queryContractSmart(
      hubAddress,
      { position: { account: aliceAddress, vault: vaultAddress } }
    );

    expect(+position.collateral).toBe(INDIVIDUAL_DEPOSIT_CAP);

    const proxyMetadata: MetadataResponse =
      await operatorClient.queryContractSmart(depositProxyAddress, {
        vault_metadata: { vault: vaultAddress },
      });

    expect(+proxyMetadata.total_deposit).toBe(INDIVIDUAL_DEPOSIT_CAP);

    const depositAmountRes: DepositAmountResponse =
      await operatorClient.queryContractSmart(depositProxyAddress, {
        deposit_amount: { vault: vaultAddress, account: aliceAddress },
      });

    expect(+depositAmountRes.amount).toBe(INDIVIDUAL_DEPOSIT_CAP);
  });

  it("bob cannot deposit more than the total cap", async () => {
    const depositAmount = INDIVIDUAL_DEPOSIT_CAP;

    expect(async () => {
      await bobClient.execute(
        bobAddress,
        depositProxyAddress,
        { deposit: { vault: vaultAddress } },
        gasFee,
        "",
        [coin(depositAmount, depositAssetDenom)]
      );
    }).toThrow("total deposit cap exceeded");
  });

  it("bob can mint up to the total cap via the proxy", async () => {
    const depositAmount = TOTAL_MINT_CAP;

    await bobClient.execute(
      bobAddress,
      depositProxyAddress,
      { mint: { vault: vaultAddress } },
      gasFee,
      "",
      [coin(depositAmount, depositAssetDenom)]
    );

    const syntheticBalance = await operatorClient.getBalance(
      bobAddress,
      syntheticAssetDenom
    );

    expect(+syntheticBalance.amount).toBeGreaterThan(0);

    const proxyMetadata: MetadataResponse =
      await operatorClient.queryContractSmart(depositProxyAddress, {
        vault_metadata: { vault: vaultAddress },
      });

    expect(+proxyMetadata.total_mint).toBe(TOTAL_MINT_CAP);
  });

  it("alice can no longer mint any assets via the proxy", async () => {
    const depositAmount = INDIVIDUAL_DEPOSIT_CAP;

    expect(async () => {
      await aliceClient.execute(
        aliceAddress,
        depositProxyAddress,
        { mint: { vault: vaultAddress } },
        gasFee,
        "",
        [coin(depositAmount, depositAssetDenom)]
      );
    }).toThrow("total mint cap exceeded");
  });

  it("cannot mint directly with the hub", async () => {
    const depositAmount = INDIVIDUAL_DEPOSIT_CAP;

    expect(async () => {
      await aliceClient.execute(
        aliceAddress,
        hubAddress,
        { mint: { vault: vaultAddress } },
        gasFee,
        "",
        [coin(depositAmount, depositAssetDenom)]
      );
    }).toThrow("unauthorized");
  });

  it("cannot deposit directly with the hub", async () => {
    const depositAmount = INDIVIDUAL_DEPOSIT_CAP;

    expect(async () => {
      await aliceClient.execute(
        aliceAddress,
        hubAddress,
        { deposit: { vault: vaultAddress } },
        gasFee,
        "",
        [coin(depositAmount, depositAssetDenom)]
      );
    }).toThrow("unauthorized");
  });

  it("non-admin cannot alter config", async () => {
    const msg: DepositProxyExecuteMsg = {
      set_config: {
        vault: vaultAddress,
        total_deposit_cap: String(TOTAL_DEPOSIT_CAP * 2),
        individual_deposit_cap: String(INDIVIDUAL_DEPOSIT_CAP * 2),
        total_mint_cap: String(TOTAL_MINT_CAP * 2),
      },
    };

    expect(async () => {
      await aliceClient.execute(aliceAddress, depositProxyAddress, msg, gasFee);
    }).toThrow("unauthorized");
  });

  it("initial queue is empty", async () => {
    const queueEntries: QueueEntriesResponse =
      await operatorClient.queryContractSmart(redeemProxyAddress, {
        all_queue_entries: { vault: vaultAddress },
      });

    expect(queueEntries.entries.length).toBe(0);
  });

  // it("vault has sufficient redemption reserves", async () => {
  //   // Check vault metadata to make sure there are enough reserves
  //   const vaultMetadata: VaultMetadata =
  //     await operatorClient.queryContractSmart(hubAddress, {
  //       vault_metadata: { vault: vaultAddress },
  //     });
  //
  //   console.log("Vault collateral balance:", vaultMetadata.collateral_balance);
  //   console.log("Vault reserve balance:", vaultMetadata.reserve_balance);
  //
  //   // We should have collateral since we've made deposits
  //   expect(+vaultMetadata.collateral_balance).toBeGreaterThan(0);
  //
  //   // We should have reserves since we've minted synthetics
  //   expect(+vaultMetadata.reserve_balance).toBeGreaterThan(0);
  // });

  it("should allow Bob to make a small redemption that processes immediately", async () => {
    const syntheticBalance = await bobClient.getBalance(
      bobAddress,
      syntheticAssetDenom
    );

    const bobPreRedeemClaimable: VaultClaimableResponse =
      await operatorClient.queryContractSmart(vaultAddress, {
        claimable: { address: bobAddress },
      });

    const preRedeemMetadata: VaultMetadata =
      await operatorClient.queryContractSmart(hubAddress, {
        vault_metadata: { vault: vaultAddress },
      });

    const preRedeemVaultState: VaultStateResponse =
      await operatorClient.queryContractSmart(vaultAddress, {
        state: {},
      });

    const preRedeemSynthSupply = await hostQueryClient.bank.supplyOf(
      `factory/${mintAddress}/amntrn`
    );

    const redeemAmount = 5000;

    const result = await bobClient.execute(
      bobAddress,
      redeemProxyAddress,
      { redeem: { vault: vaultAddress } },
      gasFee,
      "",
      [coin(redeemAmount, syntheticAssetDenom)]
    );

    // Check that the event log contains immediate processing marker
    const attrValue = result.events
      .find((e) => e.type === "wasm")
      ?.attributes.find((a) => a.key === "immediate_processed")?.value;

    expect(attrValue).toBe("1");

    // The queue should still be empty
    const queueEntries = await operatorClient.queryContractSmart(
      redeemProxyAddress,
      {
        all_queue_entries: { vault: vaultAddress },
      }
    );

    expect(queueEntries.entries.length).toBe(0);

    const newSyntheticBalance = await bobClient.getBalance(
      bobAddress,
      syntheticAssetDenom
    );

    expect(newSyntheticBalance.amount).toBe("999995000");

    const bobPostRedeemClaimable: VaultClaimableResponse =
      await operatorClient.queryContractSmart(vaultAddress, {
        claimable: { address: bobAddress },
      });

    const postRedeemMetadata: VaultMetadata =
      await operatorClient.queryContractSmart(hubAddress, {
        vault_metadata: { vault: vaultAddress },
      });

    const postRedeemVaultState: VaultStateResponse =
      await operatorClient.queryContractSmart(vaultAddress, {
        state: {},
      });

    const postRedeemSynthSupply = await hostQueryClient.bank.supplyOf(
      `factory/${mintAddress}/amntrn`
    );

    expect(bobPostRedeemClaimable.amount).toBe("5000");

    const expectedClaimable = Math.floor(Number(redeemAmount) / 1.0);

    const bobClaimableIncrease =
      +bobPostRedeemClaimable.amount - +bobPreRedeemClaimable.amount;

    const reserveBalanceDecrease =
      +preRedeemMetadata.reserve_balance - +postRedeemMetadata.reserve_balance;

    const reserveSharesDecrease =
      +preRedeemMetadata.reserve_shares - +postRedeemMetadata.reserve_shares;

    const vaultDepositsDecrease =
      +preRedeemVaultState.total_deposits -
      +postRedeemVaultState.total_deposits;

    const vaultSharesDecrease =
      +preRedeemVaultState.total_issued_shares -
      +postRedeemVaultState.total_issued_shares;

    const synthSupplyDecrease =
      +preRedeemSynthSupply.amount - +postRedeemSynthSupply.amount;

    toBeWithinN(1, bobClaimableIncrease, expectedClaimable);
    toBeWithinN(1, reserveBalanceDecrease, redeemAmount);
    toBeWithinN(
      1,
      sharesValue(preRedeemVaultState, reserveSharesDecrease),
      redeemAmount
    );
    toBeWithinN(2, vaultDepositsDecrease, redeemAmount);
    toBeWithinN(
      2,
      sharesValue(preRedeemVaultState, vaultSharesDecrease),
      redeemAmount
    );
    expect(synthSupplyDecrease).toBe(redeemAmount);
  });
});
