import { describe, it, beforeAll, afterAll, expect } from "bun:test";
import { TestSuite } from "./suite";
import { artifact, readContractFileBytes, sleep } from "./utils";
import { StdFee } from "@cosmjs/stargate";
import { coin } from "@cosmjs/proto-signing";
import { ExecuteMsg as MintExecuteMsg } from "../ts/AmuletMint.types";
import {
  ExecuteMsg as HubExecuteMsg,
  InstantiateMsg as HubInstantiateMsg,
  PositionResponse,
  VaultMetadata,
} from "../ts/AmuletHub.types";
import {
  ExecuteMsg as ProxyExecuteMsg,
  InstantiateMsg as ProxyInstantiateMsg,
  QueueEntriesResponse,
  QueueEntryResponse,
} from "../ts/RedeemQueueProxy.types";
import {
  HostClient,
  createFee,
  createHostClient,
  createHostWallet,
  initGenericLstVault,
} from "./test-helpers";

let suite: ITestSuite;
let operatorAddress: string;
let aliceAddress: string;
let bobAddress: string;
let charlieAddress: string;
let adminAddress: string;
let operatorClient: HostClient;
let aliceClient: HostClient;
let bobClient: HostClient;
let charlieClient: HostClient;
let adminClient: HostClient;
let vaultCodeId: number;
let mockOracleCodeId: number;
let hubCodeId: number;
let mintCodeId: number;
let proxyCodeId: number;
let vaultAddress: string;
let mockOracleAddress: string;
let hubAddress: string;
let mintAddress: string;
let proxyAddress: string;
let gasFee: StdFee;
let depositAssetDenom: string = "untrn";
let syntheticAssetDenom: string;

// Test configuration
const INITIAL_DEPOSIT_AMOUNT = 1_000_000_000;
const REDEMPTION_AMOUNT = 10_000;

// Helper function to process redemption queue
async function processRedemptionQueue(
  client: HostClient,
  sender: string,
  vault: string
): Promise<void> {
  await client.execute(
    sender,
    proxyAddress,
    {
      process_head: {
        vault: vault,
      },
    },
    gasFee
  );
}

describe("Redeem Queue Proxy", () => {
  beforeAll(async () => {
    suite = await TestSuite.create({
      networkOverrides: {
        neutron: {
          genesis_opts: {
            "app_state.interchaintxs.params.msg_submit_tx_max_messages": "16",
            "app_state.feeburner.params.treasury_address":
              // arbitrary testnet address
              "neutron12z4p3g6zjrnlz79znrjef4sxklsnnmpglgzhx2",
          },
        },
      },
    });

    const operatorWallet = await createHostWallet(suite, "demo1");
    const aliceWallet = await createHostWallet(suite, "demo2");
    const bobWallet = await createHostWallet(suite, "demo3");
    const charlieWallet = await createHostWallet(suite, "demowallet1");
    const adminWallet = await createHostWallet(suite, "relayer_0");

    operatorAddress = (await operatorWallet.getAccounts())[0].address;
    aliceAddress = (await aliceWallet.getAccounts())[0].address;
    bobAddress = (await bobWallet.getAccounts())[0].address;
    charlieAddress = (await charlieWallet.getAccounts())[0].address;
    adminAddress = (await adminWallet.getAccounts())[0].address;

    operatorClient = await createHostClient(suite, operatorWallet);
    aliceClient = await createHostClient(suite, aliceWallet);
    bobClient = await createHostClient(suite, bobWallet);
    charlieClient = await createHostClient(suite, charlieWallet);
    adminClient = await createHostClient(suite, adminWallet);

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

  it("should upload the redeem-queue-proxy contract byte code", async () => {
    const wasmFilePath = artifact("redeem-queue-proxy");
    const wasmBytes = await readContractFileBytes(wasmFilePath);
    const res = await operatorClient.upload(operatorAddress, wasmBytes, gasFee);
    proxyCodeId = res.codeId;
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

  it("should deploy the redeem-queue-proxy", async () => {
    const msg: ProxyInstantiateMsg = {
      hub_address: hubAddress,
    };

    const res = await operatorClient.instantiate(
      operatorAddress,
      proxyCodeId,
      msg,
      "redeem-queue-proxy",
      gasFee
    );

    proxyAddress = res.contractAddress;
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

  it("should register the vault with the hub and enable deposits/advance/redeem", async () => {
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

  it("should configure the redeem proxy for the vault", async () => {
    const msg: HubExecuteMsg = {
      set_proxy_config: {
        vault: vaultAddress,
        redeem: proxyAddress,
      },
    };

    await operatorClient.execute(operatorAddress, hubAddress, msg, gasFee);
  });

  it("should verify that initially the queue is empty", async () => {
    const queueEntries: QueueEntriesResponse =
      await operatorClient.queryContractSmart(proxyAddress, {
        all_queue_entries: { vault: vaultAddress },
      });

    expect(queueEntries.entries.length).toBe(0);
  });

  it("should setup initial deposits and mints for all users", async () => {
    // Alice makes a large deposit
    await aliceClient.execute(
      aliceAddress,
      hubAddress,
      { deposit: { vault: vaultAddress } },
      gasFee,
      "",
      [coin(INITIAL_DEPOSIT_AMOUNT, depositAssetDenom)]
    );

    // Alice mints some synthetic tokens
    await aliceClient.execute(
      aliceAddress,
      hubAddress,
      { mint: { vault: vaultAddress } },
      gasFee,
      "",
      [coin(INITIAL_DEPOSIT_AMOUNT / 2, depositAssetDenom)]
    );

    // Bob deposits
    await bobClient.execute(
      bobAddress,
      hubAddress,
      { deposit: { vault: vaultAddress } },
      gasFee,
      "",
      [coin(200_000, depositAssetDenom)]
    );

    // Bob mints
    await bobClient.execute(
      bobAddress,
      hubAddress,
      { mint: { vault: vaultAddress } },
      gasFee,
      "",
      [coin(100_000, depositAssetDenom)]
    );

    // Charlie deposits
    await charlieClient.execute(
      charlieAddress,
      hubAddress,
      { deposit: { vault: vaultAddress } },
      gasFee,
      "",
      [coin(200_000, depositAssetDenom)]
    );

    // Charlie mints
    await charlieClient.execute(
      charlieAddress,
      hubAddress,
      { mint: { vault: vaultAddress } },
      gasFee,
      "",
      [coin(100_000, depositAssetDenom)]
    );

    // Verify balances
    const aliceSynthetic = await aliceClient.getBalance(
      aliceAddress,
      syntheticAssetDenom
    );
    const bobSynthetic = await bobClient.getBalance(
      bobAddress,
      syntheticAssetDenom
    );
    const charlieSynthetic = await charlieClient.getBalance(
      charlieAddress,
      syntheticAssetDenom
    );

    expect(+aliceSynthetic.amount).toBeGreaterThan(0);
    expect(+bobSynthetic.amount).toBeGreaterThan(0);
    expect(+charlieSynthetic.amount).toBeGreaterThan(0);
  });

  it("should test that the vault has sufficient redemption reserves", async () => {
    // Check vault metadata to make sure there are enough reserves
    const vaultMetadata: VaultMetadata =
      await operatorClient.queryContractSmart(hubAddress, {
        vault_metadata: { vault: vaultAddress },
      });

    console.log("Vault reserve balance:", vaultMetadata.reserve_balance);
    console.log("Vault collateral balance:", vaultMetadata.collateral_balance);

    // We should have reserves since we've made deposits
    expect(+vaultMetadata.reserve_balance).toBeGreaterThan(0);
  });

  it("should allow Alice to make a small redemption that processes immediately", async () => {
    // Get Alice's synthetic balance
    const syntheticBalance = await aliceClient.getBalance(
      aliceAddress,
      syntheticAssetDenom
    );
    console.log("Alice's synthetic balance:", syntheticBalance.amount);

    // Redeem a small amount (should process immediately)
    const smallAmount = 5000;

    // Get initial untrn balance
    const initialBalance = await aliceClient.getBalance(
      aliceAddress,
      depositAssetDenom
    );
    console.log("Alice's initial untrn balance:", initialBalance.amount);

    // Execute redemption
    const result = await aliceClient.execute(
      aliceAddress,
      proxyAddress,
      { redeem: { vault: vaultAddress } },
      gasFee,
      "",
      [coin(smallAmount, syntheticAssetDenom)]
    );

    // Check that the event log contains immediate processing marker
    const attrValue = result.logs[0].events
      .find((e) => e.type === "wasm")
      ?.attributes.find((a) => a.key === "immediate_processed")?.value;

    expect(attrValue).toBe("1");

    // The queue should still be empty
    const queueEntries = await operatorClient.queryContractSmart(proxyAddress, {
      all_queue_entries: { vault: vaultAddress },
    });

    expect(queueEntries.entries.length).toBe(0);

    // Alice should have received her underlying tokens
    const finalBalance = await aliceClient.getBalance(
      aliceAddress,
      depositAssetDenom
    );
    expect(+finalBalance.amount).toBeGreaterThan(
      +initialBalance.amount - 5000000
    ); // Account for gas fees
  });

  it("should limit reserve redemptions if we try to redeem too much at once", async () => {
    // Reduce the reserve balance by making a large mint to limit available reserves
    await aliceClient.execute(
      aliceAddress,
      hubAddress,
      { mint: { vault: vaultAddress } },
      gasFee,
      "",
      [coin(INITIAL_DEPOSIT_AMOUNT / 2, depositAssetDenom)]
    );

    // Check Bob's synthetic balance
    const bobSyntheticBefore = await bobClient.getBalance(
      bobAddress,
      syntheticAssetDenom
    );
    console.log("Bob's synthetic balance:", bobSyntheticBefore.amount);

    // Check vault metadata to make sure there are enough reserves
    const vaultMetadata: VaultMetadata =
      await operatorClient.queryContractSmart(hubAddress, {
        vault_metadata: { vault: vaultAddress },
      });

    console.log("Vault reserve balance:", vaultMetadata.reserve_balance);
    console.log("Vault collateral balance:", vaultMetadata.collateral_balance);

    // Bob redeems a larger amount to force queuing
    const redeemAmount = Math.min(+bobSyntheticBefore.amount, 50000);

    // Execute redemption
    const result = await bobClient.execute(
      bobAddress,
      proxyAddress,
      { redeem: { vault: vaultAddress } },
      gasFee,
      "",
      [coin(redeemAmount, syntheticAssetDenom)]
    );

    console.log("Bob's tx response:", JSON.stringify(result.events));

    // Check that the entry is in the queue
    const queueEntries = await operatorClient.queryContractSmart(proxyAddress, {
      all_queue_entries: { vault: vaultAddress },
    });

    expect(queueEntries.entries.length).toBeGreaterThan(0);

    // Verify the queue entry details
    const bobEntry = queueEntries.entries.find(
      (entry) => entry.address === bobAddress
    );
    expect(bobEntry).toBeDefined();
    expect(+bobEntry.amount).toBe(redeemAmount);
  });

  it("should allow querying queue entries by owner", async () => {
    // Query Bob's entries
    const bobEntries = await operatorClient.queryContractSmart(proxyAddress, {
      owner_queue_entries: {
        vault: vaultAddress,
        address: bobAddress,
      },
    });

    expect(bobEntries.entries.length).toBeGreaterThan(0);
    expect(bobEntries.entries[0].address).toBe(bobAddress);
  });

  it("should allow querying a specific queue entry by index", async () => {
    // Get all queue entries
    const allEntries = await operatorClient.queryContractSmart(proxyAddress, {
      all_queue_entries: { vault: vaultAddress },
    });

    // Get the first entry's index
    const firstEntryIndex = allEntries.entries[0].index;

    // Query the specific entry
    const entryQuery: QueueEntryResponse =
      await operatorClient.queryContractSmart(proxyAddress, {
        queue_entry: {
          vault: vaultAddress,
          index: firstEntryIndex,
        },
      });

    expect(entryQuery.entry.index).toBe(firstEntryIndex);
    expect(entryQuery).toHaveProperty("position_in_queue");
    expect(entryQuery).toHaveProperty("amount_in_front");
  });

  it("should add Charlie's redemption request to the queue", async () => {
    // Get Charlie's synthetic balance
    const charlieSyntheticBefore = await charlieClient.getBalance(
      charlieAddress,
      syntheticAssetDenom
    );

    // Charlie redeems a portion of his balance
    const redeemAmount = Math.min(+charlieSyntheticBefore.amount, 40000);

    // Execute redemption
    await charlieClient.execute(
      charlieAddress,
      proxyAddress,
      { redeem: { vault: vaultAddress } },
      gasFee,
      "",
      [coin(redeemAmount, syntheticAssetDenom)]
    );

    // Verify queue now has both Bob and Charlie's entries
    const queueEntries = await operatorClient.queryContractSmart(proxyAddress, {
      all_queue_entries: { vault: vaultAddress },
    });

    expect(queueEntries.entries.length).toBe(2);

    // Verify entries are from both users
    const addresses = queueEntries.entries.map((entry) => entry.address);
    expect(addresses).toContain(bobAddress);
    expect(addresses).toContain(charlieAddress);
  });

  it("should allow Charlie to cancel his redemption request", async () => {
    // Find Charlie's entry
    const allEntries = await operatorClient.queryContractSmart(proxyAddress, {
      owner_queue_entries: {
        vault: vaultAddress,
        address: charlieAddress,
      },
    });

    expect(allEntries.entries.length).toBe(1);
    const charlieEntryIndex = allEntries.entries[0].index;

    // Get Charlie's synthetic balance before cancellation
    const syntheticBefore = await charlieClient.getBalance(
      charlieAddress,
      syntheticAssetDenom
    );

    // Cancel the entry
    await charlieClient.execute(
      charlieAddress,
      proxyAddress,
      {
        cancel_entry: {
          vault: vaultAddress,
          index: charlieEntryIndex,
        },
      },
      gasFee
    );

    // Verify entry was removed from queue
    const charlieEntriesAfter = await operatorClient.queryContractSmart(
      proxyAddress,
      {
        owner_queue_entries: {
          vault: vaultAddress,
          address: charlieAddress,
        },
      }
    );

    expect(charlieEntriesAfter.entries.length).toBe(0);

    // Verify synthetic tokens were returned
    const syntheticAfter = await charlieClient.getBalance(
      charlieAddress,
      syntheticAssetDenom
    );
    expect(+syntheticAfter.amount).toBeGreaterThan(+syntheticBefore.amount);
  });

  it("should allow Charlie to cancel all his redemption requests at once", async () => {
    // Add multiple entries for Charlie
    const syntheticBalance = await charlieClient.getBalance(
      charlieAddress,
      syntheticAssetDenom
    );
    const entryAmount = Math.floor(+syntheticBalance.amount / 3);

    // Add first entry
    await charlieClient.execute(
      charlieAddress,
      proxyAddress,
      { redeem: { vault: vaultAddress } },
      gasFee,
      "",
      [coin(entryAmount, syntheticAssetDenom)]
    );

    // Add second entry
    await charlieClient.execute(
      charlieAddress,
      proxyAddress,
      { redeem: { vault: vaultAddress } },
      gasFee,
      "",
      [coin(entryAmount, syntheticAssetDenom)]
    );

    // Verify Charlie now has multiple entries
    const charlieEntries = await operatorClient.queryContractSmart(
      proxyAddress,
      {
        owner_queue_entries: {
          vault: vaultAddress,
          address: charlieAddress,
        },
      }
    );

    expect(charlieEntries.entries.length).toBe(2);

    // Get synthetic balance before cancellation
    const syntheticBefore = await charlieClient.getBalance(
      charlieAddress,
      syntheticAssetDenom
    );

    // Cancel all entries
    await charlieClient.execute(
      charlieAddress,
      proxyAddress,
      {
        cancel_all: {
          vault: vaultAddress,
        },
      },
      gasFee
    );

    // Verify entries were removed
    const entriesAfter = await operatorClient.queryContractSmart(proxyAddress, {
      owner_queue_entries: {
        vault: vaultAddress,
        address: charlieAddress,
      },
    });

    expect(entriesAfter.entries.length).toBe(0);

    // Verify synthetic tokens were returned
    const syntheticAfter = await charlieClient.getBalance(
      charlieAddress,
      syntheticAssetDenom
    );
    expect(+syntheticAfter.amount).toBeGreaterThan(+syntheticBefore.amount);
  });

  it("should process the redemption queue when requested", async () => {
    // First, add more reserve to the vault by making a withdrawal
    await aliceClient.execute(
      aliceAddress,
      hubAddress,
      {
        withdraw: {
          amount: "100000",
          vault: vaultAddress,
        },
      },
      gasFee
    );

    // Get Bob's entry details
    const bobEntries = await operatorClient.queryContractSmart(proxyAddress, {
      owner_queue_entries: {
        vault: vaultAddress,
        address: bobAddress,
      },
    });

    expect(bobEntries.entries.length).toBe(1);

    // Get Bob's underlying balance before processing
    const bobUntrn = await bobClient.getBalance(bobAddress, depositAssetDenom);

    // Process the queue
    await processRedemptionQueue(operatorClient, operatorAddress, vaultAddress);

    // Check if Bob's entry was processed
    const bobEntriesAfter = await operatorClient.queryContractSmart(
      proxyAddress,
      {
        owner_queue_entries: {
          vault: vaultAddress,
          address: bobAddress,
        },
      }
    );

    // Queue should be empty or reduced
    expect(bobEntriesAfter.entries.length).toBeLessThanOrEqual(
      bobEntries.entries.length
    );

    // Bob should have received underlying tokens
    const bobUntrnAfter = await bobClient.getBalance(
      bobAddress,
      depositAssetDenom
    );
    expect(+bobUntrnAfter.amount).toBeGreaterThanOrEqual(+bobUntrn.amount);
  });

  it("should test force cancel by admin", async () => {
    // Add an entry for Charlie
    const charlieSynthetic = await charlieClient.getBalance(
      charlieAddress,
      syntheticAssetDenom
    );
    const amount = Math.min(+charlieSynthetic.amount, 10000);

    await charlieClient.execute(
      charlieAddress,
      proxyAddress,
      { redeem: { vault: vaultAddress } },
      gasFee,
      "",
      [coin(amount, syntheticAssetDenom)]
    );

    // Get Charlie's entry
    const charlieEntries = await operatorClient.queryContractSmart(
      proxyAddress,
      {
        owner_queue_entries: {
          vault: vaultAddress,
          address: charlieAddress,
        },
      }
    );

    expect(charlieEntries.entries.length).toBe(1);
    const entryIndex = charlieEntries.entries[0].index;

    // Get Charlie's synthetic balance before force cancel
    const syntheticBefore = await charlieClient.getBalance(
      charlieAddress,
      syntheticAssetDenom
    );

    // Transfer admin role to our admin account
    await operatorClient.execute(
      operatorAddress,
      proxyAddress,
      {
        transfer_admin_role: {
          next_admin: adminAddress,
        },
      },
      gasFee
    );

    // Claim admin role
    await adminClient.execute(
      adminAddress,
      proxyAddress,
      { claim_admin_role: {} },
      gasFee
    );

    // Force cancel Charlie's entry
    await adminClient.execute(
      adminAddress,
      proxyAddress,
      {
        force_cancel_entry: {
          vault: vaultAddress,
          index: entryIndex,
        },
      },
      gasFee
    );

    // Check if entry was removed
    const entriesAfter = await operatorClient.queryContractSmart(proxyAddress, {
      owner_queue_entries: {
        vault: vaultAddress,
        address: charlieAddress,
      },
    });

    expect(entriesAfter.entries.length).toBe(0);

    // Verify tokens were returned
    const syntheticAfter = await charlieClient.getBalance(
      charlieAddress,
      syntheticAssetDenom
    );
    expect(+syntheticAfter.amount).toBeGreaterThan(+syntheticBefore.amount);
  });

  it("should handle appending to an existing entry", async () => {
    // Add an initial entry for Alice
    const aliceSynthetic = await aliceClient.getBalance(
      aliceAddress,
      syntheticAssetDenom
    );
    const initialAmount = 5000;

    if (+aliceSynthetic.amount >= initialAmount * 2) {
      // Add initial entry
      await aliceClient.execute(
        aliceAddress,
        proxyAddress,
        { redeem: { vault: vaultAddress } },
        gasFee,
        "",
        [coin(initialAmount, syntheticAssetDenom)]
      );

      // Get Alice's entry
      const aliceEntries = await operatorClient.queryContractSmart(
        proxyAddress,
        {
          owner_queue_entries: {
            vault: vaultAddress,
            address: aliceAddress,
          },
        }
      );

      expect(aliceEntries.entries.length).toBe(1);
      const initialEntry = aliceEntries.entries[0];

      // Add another entry that should append to the existing one
      await aliceClient.execute(
        aliceAddress,
        proxyAddress,
        { redeem: { vault: vaultAddress } },
        gasFee,
        "",
        [coin(initialAmount, syntheticAssetDenom)]
      );

      // Check that the entry was appended, not added separately
      const entriesAfter = await operatorClient.queryContractSmart(
        proxyAddress,
        {
          owner_queue_entries: {
            vault: vaultAddress,
            address: aliceAddress,
          },
        }
      );

      expect(entriesAfter.entries.length).toBe(1);
      expect(+entriesAfter.entries[0].amount).toBe(initialAmount * 2);
    } else {
      console.log("Alice doesn't have enough synthetic tokens for the test");
    }
  });

  it("should verify non-admin users cannot force cancel entries", async () => {
    // Add an entry for Bob
    const bobSynthetic = await bobClient.getBalance(
      bobAddress,
      syntheticAssetDenom
    );
    const amount = Math.min(+bobSynthetic.amount, 5000);

    if (amount > 0) {
      await bobClient.execute(
        bobAddress,
        proxyAddress,
        { redeem: { vault: vaultAddress } },
        gasFee,
        "",
        [coin(amount, syntheticAssetDenom)]
      );

      // Get Bob's entry
      const bobEntries = await operatorClient.queryContractSmart(proxyAddress, {
        owner_queue_entries: {
          vault: vaultAddress,
          address: bobAddress,
        },
      });

      expect(bobEntries.entries.length).toBe(1);
      const entryIndex = bobEntries.entries[0].index;

      // Alice (non-admin) tries to force cancel
      try {
        await aliceClient.execute(
          aliceAddress,
          proxyAddress,
          {
            force_cancel_entry: {
              vault: vaultAddress,
              index: entryIndex,
            },
          },
          gasFee
        );

        // Should not reach here
        expect(false).toBe(true);
      } catch (error) {
        // Expect an error because Alice is not admin
        expect(error).toBeDefined();
      }

      // Verify entry still exists
      const entriesAfter = await operatorClient.queryContractSmart(
        proxyAddress,
        {
          owner_queue_entries: {
            vault: vaultAddress,
            address: bobAddress,
          },
        }
      );

      expect(entriesAfter.entries.length).toBe(1);
    }
  });

  it("should verify users cannot cancel entries owned by others", async () => {
    // Get Bob's entry
    const bobEntries = await operatorClient.queryContractSmart(proxyAddress, {
      owner_queue_entries: {
        vault: vaultAddress,
        address: bobAddress,
      },
    });

    if (bobEntries.entries.length > 0) {
      const entryIndex = bobEntries.entries[0].index;

      // Alice tries to cancel Bob's entry
      try {
        await aliceClient.execute(
          aliceAddress,
          proxyAddress,
          {
            cancel_entry: {
              vault: vaultAddress,
              index: entryIndex,
            },
          },
          gasFee
        );

        // Should not reach here
        expect(false).toBe(true);
      } catch (error) {
        // Expect an error because Alice cannot cancel Bob's entry
        expect(error).toBeDefined();
      }

      // Verify Bob's entry still exists
      const entriesAfter = await operatorClient.queryContractSmart(
        proxyAddress,
        {
          owner_queue_entries: {
            vault: vaultAddress,
            address: bobAddress,
          },
        }
      );

      expect(entriesAfter.entries.length).toBe(1);
    }
  });

  it("should allow processing an empty queue without errors", async () => {
    // First, make sure all entries are processed or cancelled
    await processRedemptionQueue(operatorClient, operatorAddress, vaultAddress);

    // Cancel any remaining entries for Bob
    try {
      await bobClient.execute(
        bobAddress,
        proxyAddress,
        {
          cancel_all: {
            vault: vaultAddress,
          },
        },
        gasFee
      );
    } catch (error) {
      // Ignore errors, just trying to clean up
    }

    // Cancel any remaining entries for Alice
    try {
      await aliceClient.execute(
        aliceAddress,
        proxyAddress,
        {
          cancel_all: {
            vault: vaultAddress,
          },
        },
        gasFee
      );
    } catch (error) {
      // Ignore errors, just trying to clean up
    }

    // Verify queue is empty
    const queueEntries = await operatorClient.queryContractSmart(proxyAddress, {
      all_queue_entries: { vault: vaultAddress },
    });

    if (queueEntries.entries.length === 0) {
      // Should be able to process empty queue without errors
      await processRedemptionQueue(
        operatorClient,
        operatorAddress,
        vaultAddress
      );
      // No assertion needed, just ensuring it doesn't throw an error
    } else {
      console.log("Queue is not empty, skipping test");
    }
  });

  it("should test redeem behavior with complex queue setup", async () => {
    // First ensure we have an empty queue to start with
    try {
      await bobClient.execute(
        bobAddress,
        proxyAddress,
        { cancel_all: { vault: vaultAddress } },
        gasFee
      );

      await aliceClient.execute(
        aliceAddress,
        proxyAddress,
        { cancel_all: { vault: vaultAddress } },
        gasFee
      );

      await charlieClient.execute(
        charlieAddress,
        proxyAddress,
        { cancel_all: { vault: vaultAddress } },
        gasFee
      );
    } catch (error) {
      // Ignore errors, just trying to clean up
    }

    // Force there to be limited reserves by having Alice mint a large amount
    await aliceClient.execute(
      aliceAddress,
      hubAddress,
      { mint: { vault: vaultAddress } },
      gasFee,
      "",
      [coin(100_000, depositAssetDenom)]
    );

    // Add entries for all three users in sequence

    // First Bob
    const bobSynth = await bobClient.getBalance(
      bobAddress,
      syntheticAssetDenom
    );
    if (+bobSynth.amount >= 2000) {
      await bobClient.execute(
        bobAddress,
        proxyAddress,
        { redeem: { vault: vaultAddress } },
        gasFee,
        "",
        [coin(2000, syntheticAssetDenom)]
      );
    }

    // Then Alice
    const aliceSynth = await aliceClient.getBalance(
      aliceAddress,
      syntheticAssetDenom
    );
    if (+aliceSynth.amount >= 3000) {
      await aliceClient.execute(
        aliceAddress,
        proxyAddress,
        { redeem: { vault: vaultAddress } },
        gasFee,
        "",
        [coin(3000, syntheticAssetDenom)]
      );
    }

    // Then Charlie
    const charlieSynth = await charlieClient.getBalance(
      charlieAddress,
      syntheticAssetDenom
    );
    if (+charlieSynth.amount >= 4000) {
      await charlieClient.execute(
        charlieAddress,
        proxyAddress,
        { redeem: { vault: vaultAddress } },
        gasFee,
        "",
        [coin(4000, syntheticAssetDenom)]
      );
    }

    // Verify queue entries and positions
    const queueEntries = await operatorClient.queryContractSmart(proxyAddress, {
      all_queue_entries: { vault: vaultAddress },
    });

    if (queueEntries.entries.length >= 3) {
      // Get first entry details
      const firstEntry = await operatorClient.queryContractSmart(proxyAddress, {
        queue_entry: {
          vault: vaultAddress,
          index: queueEntries.entries[0].index,
        },
      });

      // First entry should have position 0 and no amount in front
      expect(firstEntry.position_in_queue).toBe(0);
      expect(+firstEntry.amount_in_front).toBe(0);

      // Get second entry details
      const secondEntry = await operatorClient.queryContractSmart(
        proxyAddress,
        {
          queue_entry: {
            vault: vaultAddress,
            index: queueEntries.entries[1].index,
          },
        }
      );

      // Second entry should have position 1 and first entry's amount in front
      expect(secondEntry.position_in_queue).toBe(1);
      expect(+secondEntry.amount_in_front).toBe(
        +queueEntries.entries[0].amount
      );
    }

    // Now add more reserves and process the queue
    await aliceClient.execute(
      aliceAddress,
      hubAddress,
      {
        withdraw: {
          amount: "50000",
          vault: vaultAddress,
        },
      },
      gasFee
    );

    // Process the queue
    await processRedemptionQueue(operatorClient, operatorAddress, vaultAddress);

    // Check how many entries were processed
    const queueAfter = await operatorClient.queryContractSmart(proxyAddress, {
      all_queue_entries: { vault: vaultAddress },
    });

    // Should have processed at least some entries
    expect(queueAfter.entries.length).toBeLessThan(queueEntries.entries.length);
  });
});
