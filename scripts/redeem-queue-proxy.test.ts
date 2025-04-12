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
import { GENESIS_ALLOCATION } from "./suite/constants";

function sharesValue(vaultState: VaultStateResponse, shares: any): bigint {
  return (
    (BigInt(shares) * BigInt(vaultState.total_deposits)) /
    BigInt(vaultState.total_issued_shares)
  );
}

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
let redeemProxyCodeId: number;
let vaultAddress: string;
let mockOracleAddress: string;
let hubAddress: string;
let mintAddress: string;
let redeemProxyAddress: string;
let gasFee: StdFee;
let depositAssetDenom: string = "untrn";
let syntheticAssetDenom: string;

describe("Redeem Queue Proxy", () => {
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

  it("should configure the fixed advance fee to 100 bps (1%)", async () => {
    await operatorClient.execute(
      operatorAddress,
      hubAddress,
      {
        set_fixed_advance_fee: { vault: vaultAddress, bps: 100 },
      },
      gasFee
    );

    const vaultMetadata: VaultMetadata =
      await operatorClient.queryContractSmart(hubAddress, {
        vault_metadata: { vault: vaultAddress },
      });

    expect(vaultMetadata.fixed_advance_fee_bps).toBe(100);
  });

  it("should configure the advance fee recipient to be the operator address", async () => {
    await operatorClient.execute(
      operatorAddress,
      hubAddress,
      {
        set_advance_fee_recipient: {
          vault: vaultAddress,
          recipient: operatorAddress,
        },
      } as HubExecuteMsg,
      gasFee
    );

    const vaultMetadata: VaultMetadata =
      await operatorClient.queryContractSmart(hubAddress, {
        vault_metadata: { vault: vaultAddress },
      });

    expect(vaultMetadata.advance_fee_recipient).toBe(operatorAddress);
  });

  it("should configure the redeem proxy for the vault", async () => {
    const msg: HubExecuteMsg = {
      set_proxy_config: {
        vault: vaultAddress,
        redeem: redeemProxyAddress,
      },
    };

    await operatorClient.execute(operatorAddress, hubAddress, msg, gasFee);
  });

  it("alice makes a deposit while the redemption rate is 1.0", async () => {
    const depositAmount = GENESIS_ALLOCATION / 10;

    await aliceClient.execute(
      aliceAddress,
      hubAddress,
      { deposit: { vault: vaultAddress } },
      gasFee,
      "",
      [coin(depositAmount, "untrn")]
    );

    const position: PositionResponse = await operatorClient.queryContractSmart(
      hubAddress,
      { position: { account: aliceAddress, vault: vaultAddress } }
    );

    expect(+position.collateral).toBe(depositAmount);
  });

  it("alice takes an advance while the redemption rate is still 1.0", async () => {
    const advanceAmount = GENESIS_ALLOCATION / 10 / 2;

    const advanceFeeAmount = advanceAmount / 100;

    await aliceClient.execute(
      aliceAddress,
      hubAddress,
      {
        advance: { vault: vaultAddress, amount: String(advanceAmount) },
      },
      gasFee
    );

    const position: PositionResponse = await operatorClient.queryContractSmart(
      hubAddress,
      { position: { account: aliceAddress, vault: vaultAddress } }
    );

    const aliceSynthBalance = await hostQueryClient.bank.balance(
      aliceAddress,
      `factory/${mintAddress}/amntrn`
    );

    const operatorSynthBalance = await hostQueryClient.bank.balance(
      operatorAddress,
      `factory/${mintAddress}/amntrn`
    );

    expect(+position.debt).toBe(advanceAmount);
    toBeWithinN(1, +aliceSynthBalance.amount, advanceAmount - advanceFeeAmount);
    toBeWithinN(1, +operatorSynthBalance.amount, advanceFeeAmount);
  });

  it("bob makes a deposit while the redemption rate is 1.0", async () => {
    const depositAmount = GENESIS_ALLOCATION / 10;

    await bobClient.execute(
      bobAddress,
      hubAddress,
      { deposit: { vault: vaultAddress } },
      gasFee,
      "",
      [coin(depositAmount, "untrn")]
    );

    const position: PositionResponse = await operatorClient.queryContractSmart(
      hubAddress,
      { position: { account: bobAddress, vault: vaultAddress } }
    );

    expect(+position.collateral).toBe(depositAmount);
  });

  it("bob takes an advance while the redemption rate is still 1.0", async () => {
    const advanceAmount = GENESIS_ALLOCATION / 10 / 2;

    const advanceFeeAmount = advanceAmount / 100;

    await bobClient.execute(
      bobAddress,
      hubAddress,
      {
        advance: { vault: vaultAddress, amount: String(advanceAmount) },
      },
      gasFee
    );

    const position: PositionResponse = await operatorClient.queryContractSmart(
      hubAddress,
      { position: { account: bobAddress, vault: vaultAddress } }
    );

    const bobSynthBalance = await hostQueryClient.bank.balance(
      bobAddress,
      `factory/${mintAddress}/amntrn`
    );

    expect(+position.debt).toBe(advanceAmount);
    toBeWithinN(1, +bobSynthBalance.amount, advanceAmount - advanceFeeAmount);
  });

  it("set the redemption rate to 1.1 (10% increase in value)", async () => {
    await operatorClient.execute(
      operatorAddress,
      mockOracleAddress,
      {
        set_redemption_rate: {
          rate: "1.1",
        },
      },
      gasFee
    );
  });

  it("alice evaluates her position after the redemption rate increase", async () => {
    await aliceClient.execute(
      aliceAddress,
      hubAddress,
      { evaluate: { vault: vaultAddress } },
      gasFee
    );

    const position: PositionResponse = await operatorClient.queryContractSmart(
      hubAddress,
      { position: { account: aliceAddress, vault: vaultAddress } }
    );

    const vaultMetadata: VaultMetadata =
      await operatorClient.queryContractSmart(hubAddress, {
        vault_metadata: { vault: vaultAddress },
      });

    const vaultState: VaultStateResponse =
      await operatorClient.queryContractSmart(vaultAddress, {
        state: {},
      });

    const collateral = +position.collateral;
    const totalYield = collateral * 0.1;
    const debtPayment = totalYield * 0.9;

    const expectedDebt = collateral / 2 - debtPayment;

    const aggregateHubSharesBalances =
      BigInt(vaultMetadata.collateral_shares) +
      BigInt(vaultMetadata.reserve_shares) +
      BigInt(vaultMetadata.treasury_shares) +
      BigInt(vaultMetadata.amo_shares);

    expect(aggregateHubSharesBalances).toBe(
      BigInt(vaultState.total_issued_shares)
    );

    toBeWithinN(1, +position.debt, expectedDebt);
    toBeWithinN(1, +vaultMetadata.reserve_balance, debtPayment * 2);

    const expectedTreasuryPaymentValue =
      BigInt(totalYield) - BigInt(debtPayment);

    const treasurySharesValue =
      (BigInt(vaultMetadata.treasury_shares) *
        BigInt(vaultState.total_deposits)) /
      BigInt(vaultState.total_issued_shares);

    toBeWithinN(1, treasurySharesValue, expectedTreasuryPaymentValue * 2n);
  });

  it("bob evaluates his position after the redemption rate increase", async () => {
    await bobClient.execute(
      bobAddress,
      hubAddress,
      { evaluate: { vault: vaultAddress } },
      gasFee
    );

    const position: PositionResponse = await operatorClient.queryContractSmart(
      hubAddress,
      { position: { account: bobAddress, vault: vaultAddress } }
    );

    const vaultMetadata: VaultMetadata =
      await operatorClient.queryContractSmart(hubAddress, {
        vault_metadata: { vault: vaultAddress },
      });

    const vaultState: VaultStateResponse =
      await operatorClient.queryContractSmart(vaultAddress, {
        state: {},
      });

    const collateral = +position.collateral;
    const totalYield = collateral * 0.1;
    const debtPayment = totalYield * 0.9;

    const expectedDebt = collateral / 2 - debtPayment;

    const aggregateHubSharesBalances =
      BigInt(vaultMetadata.collateral_shares) +
      BigInt(vaultMetadata.reserve_shares) +
      BigInt(vaultMetadata.treasury_shares) +
      BigInt(vaultMetadata.amo_shares);

    expect(aggregateHubSharesBalances).toBe(
      BigInt(vaultState.total_issued_shares)
    );

    toBeWithinN(1, +position.debt, expectedDebt);
    toBeWithinN(1, +vaultMetadata.reserve_balance, debtPayment * 2);

    const expectedTreasuryPaymentValue =
      BigInt(totalYield) - BigInt(debtPayment);

    const treasurySharesValue =
      (BigInt(vaultMetadata.treasury_shares) *
        BigInt(vaultState.total_deposits)) /
      BigInt(vaultState.total_issued_shares);

    toBeWithinN(1, treasurySharesValue, expectedTreasuryPaymentValue * 2n);
  });

  // --- Begin redeem-queue specific tests

  it("should start with an empty queue", async () => {
    const queueEntries: QueueEntriesResponse =
      await operatorClient.queryContractSmart(redeemProxyAddress, {
        all_queue_entries: { vault: vaultAddress },
      });

    expect(queueEntries.entries.length).toBe(0);
  });

  it("should allow alice to make a small redemption that processes immediately", async () => {
    const alicePreRedeemClaimable: VaultClaimableResponse =
      await operatorClient.queryContractSmart(vaultAddress, {
        claimable: { address: aliceAddress },
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
      syntheticAssetDenom
    );

    const redeemAmount = 500_000;

    await aliceClient.execute(
      aliceAddress,
      redeemProxyAddress,
      { redeem: { vault: vaultAddress } },
      gasFee,
      "",
      [coin(redeemAmount, syntheticAssetDenom)]
    );

    // The queue should still be empty
    const queueEntries = await operatorClient.queryContractSmart(
      redeemProxyAddress,
      {
        all_queue_entries: { vault: vaultAddress },
      }
    );

    expect(queueEntries.entries.length).toBe(0);

    const alicePostRedeemClaimable: VaultClaimableResponse =
      await operatorClient.queryContractSmart(vaultAddress, {
        claimable: { address: aliceAddress },
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
      syntheticAssetDenom
    );

    const expectedClaimable = Math.floor(Number(redeemAmount) / 1.1);

    const aliceClaimableIncrease =
      +alicePostRedeemClaimable.amount - +alicePreRedeemClaimable.amount;

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

    toBeWithinN(1, aliceClaimableIncrease, expectedClaimable);
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

  it("should create a queue entry when alice redeems more than available reserves", async () => {
    // Get the current reserve balance
    const vaultMetadata = await operatorClient.queryContractSmart(hubAddress, {
      vault_metadata: { vault: vaultAddress },
    });

    // Calculate an amount more than available reserves
    const redeemAmount = Number(vaultMetadata.reserve_balance) + 1_000_000;

    await aliceClient.execute(
      aliceAddress,
      redeemProxyAddress,
      { redeem: { vault: vaultAddress } },
      gasFee,
      "",
      [coin(redeemAmount, syntheticAssetDenom)]
    );

    // Check queue - should have an entry now
    const queueEntries = await operatorClient.queryContractSmart(
      redeemProxyAddress,
      { all_queue_entries: { vault: vaultAddress } }
    );

    expect(queueEntries.entries.length).toBe(1);
    expect(queueEntries.entries[0].address).toBe(aliceAddress);

    // The amount in the queue should be the portion that couldn't be immediately processed
    const queuedAmount = Number(queueEntries.entries[0].amount);

    expect(queuedAmount).toBeGreaterThan(0);
    expect(queuedAmount).toBeLessThanOrEqual(1_000_000);
  });

  it("should create a queue entry when bob tries to redeem anything", async () => {
    const redeemAmount = 2_000_000;

    await bobClient.execute(
      bobAddress,
      redeemProxyAddress,
      { redeem: { vault: vaultAddress } },
      gasFee,
      "",
      [coin(redeemAmount, syntheticAssetDenom)]
    );

    // Check queue - should have two entries now
    const queueEntries = await operatorClient.queryContractSmart(
      redeemProxyAddress,
      { all_queue_entries: { vault: vaultAddress } }
    );

    expect(queueEntries.entries.length).toBe(2);
    expect(queueEntries.entries[1].address).toBe(bobAddress);

    const queuedAmount = Number(queueEntries.entries[0].amount);

    // The amount in the queue should be the sum of Alice and Bob redeem amounts.
    expect(queuedAmount).toBeGreaterThan(0);
    expect(queuedAmount).toBeLessThanOrEqual(3_000_000);
  });

  it("should correctly calculate position and amount in front for queue entries", async () => {
    // Check the position of Bob's entry
    const bobEntryIndex = 2; // Third entry is Bob's
    const bobEntry: QueueEntryResponse =
      await operatorClient.queryContractSmart(redeemProxyAddress, {
        queue_entry: { vault: vaultAddress, index: bobEntryIndex },
      });

    expect(bobEntry.position_in_queue).toBe(1); // Position is zero-indexed
    expect(Number(bobEntry.amount_in_front)).toBeGreaterThan(0); // TODO: expect an actual amount
  });

  it("should allow Bob to view all his queue entries", async () => {
    const bobEntries: QueueEntriesResponse =
      await operatorClient.queryContractSmart(redeemProxyAddress, {
        owner_queue_entries: { vault: vaultAddress, address: bobAddress },
      });

    expect(bobEntries.entries.length).toBe(1);
    expect(bobEntries.entries[0].address).toBe(bobAddress);
  });

  it("should allow Alice to cancel her redemption queue entry", async () => {
    const aliceEntries: QueueEntriesResponse =
      await operatorClient.queryContractSmart(redeemProxyAddress, {
        owner_queue_entries: { vault: vaultAddress, address: aliceAddress },
      });

    const aliceEntryIndex = aliceEntries.entries[0].index;
    const aliceEntryAmount = aliceEntries.entries[0].amount;

    const preBalance = await aliceClient.getBalance(
      aliceAddress,
      syntheticAssetDenom
    );

    await aliceClient.execute(
      aliceAddress,
      redeemProxyAddress,
      { cancel_entry: { vault: vaultAddress, index: aliceEntryIndex } },
      gasFee
    );

    const postBalance = await aliceClient.getBalance(
      aliceAddress,
      syntheticAssetDenom
    );
    expect(BigInt(postBalance.amount) - BigInt(preBalance.amount)).toBe(
      BigInt(aliceEntryAmount)
    );

    // Queue should now only have Bob's entry
    const queueEntries: QueueEntriesResponse =
      await operatorClient.queryContractSmart(redeemProxyAddress, {
        all_queue_entries: { vault: vaultAddress },
      });

    expect(queueEntries.entries.length).toBe(1);
    expect(queueEntries.entries[0].address).toBe(bobAddress);
  });

  it("should process queue head when reserves become available", async () => {
    // Alice mints some synthetic tokens (increases vault reserves)
    // (Vault reserves increase by 1.1x the amount minted)
    await aliceClient.execute(
      aliceAddress,
      hubAddress,
      { mint: { vault: vaultAddress } },
      gasFee,
      "",
      [coin(2_000_000, depositAssetDenom)]
    );

    // Process the queue (should only have Bob's entry)
    await operatorClient.execute(
      operatorAddress,
      redeemProxyAddress,
      { process_head: { vault: vaultAddress } },
      gasFee
    );

    // The queue should now be empty or reduced
    const queueEntries: QueueEntriesResponse =
      await operatorClient.queryContractSmart(redeemProxyAddress, {
        all_queue_entries: { vault: vaultAddress },
      });

    // Reserve amount was enough to fully process Bob's entry
    expect(queueEntries.entries.length).toBe(0);

    const bobClaimable: VaultClaimableResponse =
      await operatorClient.queryContractSmart(vaultAddress, {
        claimable: { address: bobAddress },
      });

    const expectedClaimable = Math.floor(2_000_000 / 1.1);

    toBeWithinN(1, Number(bobClaimable.amount), expectedClaimable);
  });

  // NOTE: Queue is empty at this point.

  // TODO: this test could be better. it's only cancelling one entry because her redeems combine
  it("should allow Alice to cancel all her redemption entries", async () => {
    // Add multiple entries for Alice

    // This one should have a partial instant redemption
    await aliceClient.execute(
      aliceAddress,
      redeemProxyAddress,
      { redeem: { vault: vaultAddress } },
      gasFee,
      "",
      [coin(1_000_000, syntheticAssetDenom)]
    );

    await aliceClient.execute(
      aliceAddress,
      redeemProxyAddress,
      { redeem: { vault: vaultAddress } },
      gasFee,
      "",
      [coin(1_000_000, syntheticAssetDenom)]
    );

    // Verify Alice has an entry
    const aliceEntriesBefore: QueueEntriesResponse =
      await operatorClient.queryContractSmart(redeemProxyAddress, {
        owner_queue_entries: { vault: vaultAddress, address: aliceAddress },
      });

    expect(aliceEntriesBefore.entries.length).toBeGreaterThanOrEqual(1);

    const preBalance = await aliceClient.getBalance(
      aliceAddress,
      syntheticAssetDenom
    );

    // Cancel all entries
    await aliceClient.execute(
      aliceAddress,
      redeemProxyAddress,
      { cancel_all: { vault: vaultAddress } },
      gasFee
    );

    // Check that all entries are gone
    const aliceEntriesAfter: QueueEntriesResponse =
      await operatorClient.queryContractSmart(redeemProxyAddress, {
        owner_queue_entries: { vault: vaultAddress, address: aliceAddress },
      });

    expect(aliceEntriesAfter.entries.length).toBe(0);

    const postBalance = await aliceClient.getBalance(
      aliceAddress,
      syntheticAssetDenom
    );
    expect(BigInt(postBalance.amount)).toBeGreaterThan(
      BigInt(preBalance.amount)
    );
  });

  // it("should allow admin to force cancel an entry", async () => {
  //   // Add an entry for Bob again
  //   await bobClient.execute(
  //     bobAddress,
  //     redeemProxyAddress,
  //     { redeem: { vault: vaultAddress } },
  //     gasFee,
  //     "",
  //     [coin(50000, syntheticAssetDenom)]
  //   );
  //
  //   // Get Bob's entry index
  //   const bobEntries: QueueEntriesResponse =
  //     await operatorClient.queryContractSmart(redeemProxyAddress, {
  //       owner_queue_entries: { vault: vaultAddress, address: bobAddress },
  //     });
  //
  //   const bobEntryIndex = bobEntries.entries[0].index;
  //   const preBalance = await bobClient.getBalance(
  //     bobAddress,
  //     syntheticAssetDenom
  //   );
  //
  //   // Admin force cancels the entry
  //   await operatorClient.execute(
  //     operatorAddress,
  //     redeemProxyAddress,
  //     { force_cancel_entry: { vault: vaultAddress, index: bobEntryIndex } },
  //     gasFee
  //   );
  //
  //   // Verify entry is gone
  //   const queueEntries: QueueEntriesResponse =
  //     await operatorClient.queryContractSmart(redeemProxyAddress, {
  //       all_queue_entries: { vault: vaultAddress },
  //     });
  //
  //   expect(
  //     queueEntries.entries.find((e) => e.index === bobEntryIndex)
  //   ).toBeUndefined();
  //
  //   const postBalance = await bobClient.getBalance(
  //     bobAddress,
  //     syntheticAssetDenom
  //   );
  //   expect(BigInt(postBalance.amount)).toBeGreaterThan(
  //     BigInt(preBalance.amount)
  //   );
  // });

  // it("should not allow non-admin to force cancel entries", async () => {
  //   // Get Bob's entry
  //   const bobEntries: QueueEntriesResponse =
  //     await operatorClient.queryContractSmart(redeemProxyAddress, {
  //       owner_queue_entries: { vault: vaultAddress, address: bobAddress },
  //     });
  //
  //   console.log("Bob Entries: ", JSON.stringify(bobEntries));
  //
  //   const bobEntryIndex = bobEntries.entries.at(-1)!.index;
  //
  //   // Bob tries to force cancel (should fail)
  //   expect(async () => {
  //     await bobClient.execute(
  //       bobAddress,
  //       redeemProxyAddress,
  //       { force_cancel_entry: { vault: vaultAddress, index: bobEntryIndex } },
  //       gasFee
  //     );
  //   }).toThrow("unauthorized");
  // });

  // it("should not allow users to cancel other user's entries", async () => {
  //   // Add an entry for Alice
  //   await aliceClient.execute(
  //     aliceAddress,
  //     redeemProxyAddress,
  //     { redeem: { vault: vaultAddress } },
  //     gasFee,
  //     "",
  //     [coin(10000, syntheticAssetDenom)]
  //   );
  //
  //   // Get Alice's entry
  //   const aliceEntries: QueueEntriesResponse =
  //     await operatorClient.queryContractSmart(redeemProxyAddress, {
  //       owner_queue_entries: { vault: vaultAddress, address: aliceAddress },
  //     });
  //
  //   console.log("Alice Entries: ", JSON.stringify(aliceEntries));
  //
  //   const aliceEntryIndex = aliceEntries.entries.at(-1)!.index;
  //
  //   // Bob tries to cancel Alice's entry (should fail)
  //   expect(async () => {
  //     await bobClient.execute(
  //       bobAddress,
  //       redeemProxyAddress,
  //       { cancel_entry: { vault: vaultAddress, index: aliceEntryIndex } },
  //       gasFee
  //     );
  //   }).toThrow("does not belong to");
  // });

  // it("should handle cancelling non-existent entries", async () => {
  //   const nonExistentIndex = 999999;
  //
  //   // Try to cancel a non-existent entry
  //   expect(async () => {
  //     await bobClient.execute(
  //       bobAddress,
  //       redeemProxyAddress,
  //       { cancel_entry: { vault: vaultAddress, index: nonExistentIndex } },
  //       gasFee
  //     );
  //   }).toThrow("not found");
  // });
  //
  // it("should handle redeeming when reserves are completely empty", async () => {
  //   // First, ensure reserves are empty by processing any queued redemptions
  //   const vaultMetadata: VaultMetadata =
  //     await operatorClient.queryContractSmart(hubAddress, {
  //       vault_metadata: { vault: vaultAddress },
  //     });
  //
  //   if (Number(vaultMetadata.reserve_balance) > 0) {
  //     // Redeem all available reserves
  //     await bobClient.execute(
  //       bobAddress,
  //       redeemProxyAddress,
  //       { redeem: { vault: vaultAddress } },
  //       gasFee,
  //       "",
  //       [coin(vaultMetadata.reserve_balance, syntheticAssetDenom)]
  //     );
  //
  //     // Process any queue
  //     await operatorClient.execute(
  //       operatorAddress,
  //       redeemProxyAddress,
  //       { process_head: { vault: vaultAddress } },
  //       gasFee
  //     );
  //   }
  //
  //   // Now try to redeem with empty reserves
  //   await bobClient.execute(
  //     bobAddress,
  //     redeemProxyAddress,
  //     { redeem: { vault: vaultAddress } },
  //     gasFee,
  //     "",
  //     [coin(5000, syntheticAssetDenom)]
  //   );
  //
  //   // Should have an entry in the queue now
  //   const queueEntries: QueueEntriesResponse =
  //     await operatorClient.queryContractSmart(redeemProxyAddress, {
  //       all_queue_entries: { vault: vaultAddress },
  //     });
  //
  //   expect(queueEntries.entries.length).toBeGreaterThan(0);
  //   expect(queueEntries.entries.some((e) => e.address === bobAddress)).toBe(
  //     true
  //   );
  // });
});
