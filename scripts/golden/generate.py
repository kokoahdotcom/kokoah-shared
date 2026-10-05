#!/usr/bin/env python3
"""
Golden signing vectors from the official Hyperliquid Python SDK (hyperliquid-python-sdk).

Produces test/golden/vectors.json: for fixed, obviously fake private keys, fixed nonces and fixed actions, the exact
action dicts the Python SDK signs, the L1 action hash (connectionId) and the {r, s, v} signatures, for both L1 actions
and user-signed actions. The TypeScript tests (test/golden.test.ts) must reproduce every signature.

Nothing here talks to the network. The keys are public test constants: never fund them.

Regenerate (from the repo root; the venv lives OUTSIDE the repo):
    python3 -m venv /path/outside/repo/golden-venv
    /path/outside/repo/golden-venv/bin/pip install hyperliquid-python-sdk==0.24.0
    /path/outside/repo/golden-venv/bin/python scripts/golden/generate.py > test/golden/vectors.json
"""
import json
import sys
from importlib.metadata import version

import eth_account
from hyperliquid.utils.signing import (
    action_hash,
    float_to_wire,
    order_request_to_order_wire,
    order_wires_to_order_action,
    sign_agent,
    sign_approve_builder_fee,
    sign_inner,
    sign_l1_action,
    sign_send_asset_action,
    sign_token_delegate_action,
    sign_user_set_abstraction_action,
    sign_user_signed_action,
    sign_withdraw_from_bridge_action,
    user_signed_payload,
)
from hyperliquid.utils.types import Cloid

# Obviously fake, public test keys. NEVER fund these.
KEY_A = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
KEY_B = "0xfedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"

BUILDER = "0x1111111111111111111111111111111111111111"
VAULT = "0x2222222222222222222222222222222222222222"
DESTINATION = "0x3333333333333333333333333333333333333333"

NONCE = 1790000000000  # 2026-09-21T13:33:20Z
EXPIRES_AFTER = NONCE + 15_000
AGENT_VALID_UNTIL = NONCE + 30 * 24 * 60 * 60 * 1000

C1 = "0x6b6f0101000000000000000000000001"
C2 = "0x6b6f0101000000000000000000000002"
C3 = "0x6b6f0101000000000000000000000003"
C4 = "0x6b6f0101000000000000000000000004"
C5 = "0x6b6f0101000000000000000000000005"
C6 = "0x6b6f0101000000000000000000000006"
C7 = "0x6b6f0101000000000000000000000007"
C8 = "0x6b6f0101000000000000000000000008"

# Asset ids from the mainnet fixture (test/fixtures/mainnet-allPerpMetas.json).
BTC, ETH, SOL, KPEPE, HYPE = 0, 1, 5, 15, 159
XYZ_SP500 = 100000 + 1 * 10000 + 52
# Spot: 10000 + spotMeta index (test/fixtures/mainnet-spotMeta.json): @166 is USDT0/USDC.
USDT0_USDC = 10000 + 166

wallet_a = eth_account.Account.from_key(KEY_A)
wallet_b = eth_account.Account.from_key(KEY_B)


def wire(asset, is_buy, sz, px, order_type, reduce_only=False, cloid=None):
    req = {"coin": "", "is_buy": is_buy, "sz": sz, "limit_px": px, "order_type": order_type, "reduce_only": reduce_only}
    if cloid is not None:
        req["cloid"] = Cloid.from_str(cloid)
    return order_request_to_order_wire(req, asset)


def gtc():
    return {"limit": {"tif": "Gtc"}}


def trig(trigger_px, is_market, tpsl):
    return {"trigger": {"triggerPx": trigger_px, "isMarket": is_market, "tpsl": tpsl}}


vectors = []


def l1(name, action, is_mainnet, vault=None, expires_after=None, key=KEY_A, note=None):
    wallet = eth_account.Account.from_key(key)
    sig = sign_l1_action(wallet, action, vault, NONCE, expires_after, is_mainnet)
    vectors.append(
        {
            "name": name,
            "kind": "l1",
            "isMainnet": is_mainnet,
            "privateKey": key,
            "signer": wallet.address.lower(),
            "nonce": NONCE,
            "vaultAddress": vault,
            "expiresAfter": expires_after,
            "action": action,
            "connectionId": "0x" + action_hash(action, vault, NONCE, expires_after).hex(),
            "signature": sig,
            **({"note": note} if note else {}),
        }
    )


def user_signed(name, action, sign_fn, is_mainnet, key=KEY_A):
    wallet = eth_account.Account.from_key(key)
    action = dict(action)
    sig = sign_fn(wallet, action, is_mainnet)  # mutates action: adds signatureChainId (0x66eee) and hyperliquidChain
    vectors.append(
        {
            "name": name,
            "kind": "userSigned",
            "isMainnet": is_mainnet,
            "privateKey": key,
            "signer": wallet.address.lower(),
            "nonce": NONCE,
            "action": action,
            "signature": sig,
        }
    )


# ---------------------------------------------------------------------------------------------
# L1 actions
# ---------------------------------------------------------------------------------------------

order_builder = order_wires_to_order_action(
    [wire(BTC, True, 0.001, 100000.0, gtc(), cloid=C1)], {"b": BUILDER, "f": 25}
)
l1("order_limit_builder_mainnet", order_builder, True)
l1("order_limit_builder_testnet", order_builder, False)

l1(
    "order_normal_tpsl_mainnet",
    order_wires_to_order_action(
        [
            wire(ETH, True, 0.5, 2500.5, gtc(), cloid=C1),
            wire(ETH, False, 0.5, 2430.0, trig(2700.0, True, "tp"), reduce_only=True, cloid=C2),
            wire(ETH, False, 0.5, 2160.0, trig(2400.0, True, "sl"), reduce_only=True, cloid=C3),
        ],
        {"b": BUILDER, "f": 10},
        "normalTpsl",
    ),
    True,
)

l1(
    "order_hip3_market_ioc_testnet",
    order_wires_to_order_action(
        [wire(XYZ_SP500, False, 0.25, 6721.3, {"limit": {"tif": "Ioc"}}, cloid=C4)], {"b": BUILDER, "f": 25}
    ),
    False,
)

l1(
    "order_vault_mainnet",
    order_wires_to_order_action(
        [wire(SOL, False, 1.5, 180.25, gtc(), reduce_only=True, cloid=C5)], {"b": BUILDER, "f": 25}
    ),
    True,
    vault=VAULT,
)

l1(
    "order_expires_after_testnet",
    order_wires_to_order_action([wire(KPEPE, True, 1000.0, 0.012345, {"limit": {"tif": "Alo"}}, cloid=C6)]),
    False,
    expires_after=EXPIRES_AFTER,
)

l1(
    "order_vault_and_expires_after_mainnet",
    order_wires_to_order_action([wire(HYPE, True, 2.0, 45.123, gtc(), cloid=C1)], {"b": BUILDER, "f": 100}),
    True,
    vault=VAULT,
    expires_after=EXPIRES_AFTER,
)

l1(
    "order_stop_limit_position_tpsl_mainnet",
    order_wires_to_order_action(
        [wire(BTC, False, 0.002, 89500.0, trig(90000.0, False, "sl"), reduce_only=True, cloid=C7)],
        {"b": BUILDER, "f": 25},
        "positionTpsl",
    ),
    True,
)

l1(
    "cancel_mainnet",
    {"type": "cancel", "cancels": [{"a": BTC, "o": 123456789012}, {"a": XYZ_SP500, "o": 42}]},
    True,
    note="oid above 2^32 exercises uint64 msgpack encoding",
)

l1("cancel_by_cloid_testnet", {"type": "cancelByCloid", "cancels": [{"asset": ETH, "cloid": C1}]}, False)

l1("update_leverage_mainnet", {"type": "updateLeverage", "asset": XYZ_SP500, "isCross": False, "leverage": 20}, True)

l1(
    "update_isolated_margin_mainnet",
    {"type": "updateIsolatedMargin", "asset": SOL, "isBuy": True, "ntli": -2500000},
    True,
    note="negative ntli (remove 2.5 USD)",
)

l1("schedule_cancel_set_mainnet", {"type": "scheduleCancel", "time": NONCE + 60_000}, True)
l1("schedule_cancel_clear_testnet", {"type": "scheduleCancel"}, False)

l1(
    "modify_by_oid_mainnet",
    {"type": "modify", "oid": 987654321, "order": wire(ETH, True, 0.5, 2490.0, gtc(), cloid=C8)},
    True,
)

l1(
    "modify_by_cloid_testnet",
    {
        "type": "modify",
        "oid": C7,
        "order": wire(BTC, False, 0.002, 81000.0, trig(90000.0, True, "sl"), reduce_only=True, cloid=C8),
    },
    False,
)

l1(
    "batch_modify_mainnet",
    {
        "type": "batchModify",
        "modifies": [
            {"oid": 1, "order": wire(BTC, True, 0.001, 99000.0, gtc(), cloid=C1)},
            {"oid": C2, "order": wire(ETH, False, 0.1, 2600.0, gtc(), cloid=C3)},
        ],
    },
    True,
    note="sign-only vector (compileAction does not emit batchModify)",
)

l1("noop_mainnet", {"type": "noop"}, True)

# ---------------------------------------------------------------------------------------------
# User-signed actions (Python SDK hardcodes signatureChainId 0x66eee)
# ---------------------------------------------------------------------------------------------

approve_agent = {
    "type": "approveAgent",
    "agentAddress": wallet_b.address.lower(),
    "agentName": f"kokoah-web valid_until {AGENT_VALID_UNTIL}",
    "nonce": NONCE,
}
user_signed("approve_agent_mainnet", approve_agent, sign_agent, True)
user_signed("approve_agent_testnet", approve_agent, sign_agent, False)

user_signed(
    "approve_builder_fee_mainnet",
    {"maxFeeRate": "0.1%", "builder": BUILDER, "nonce": NONCE, "type": "approveBuilderFee"},
    sign_approve_builder_fee,
    True,
)
user_signed(
    "approve_builder_fee_testnet",
    {"maxFeeRate": "0.025%", "builder": BUILDER, "nonce": NONCE, "type": "approveBuilderFee"},
    sign_approve_builder_fee,
    False,
)
user_signed(
    "withdraw_mainnet",
    {"destination": DESTINATION, "amount": "12.5", "time": NONCE, "type": "withdraw3"},
    sign_withdraw_from_bridge_action,
    True,
)

# sendAsset (Exchange.send_asset builds this dict; token is "name:tokenId"; fromSubAccount "" = the main account).
USDC_MAINNET = "USDC:0x6d1e7cde53ba9467b783cb7c530ce054"
USDC_TESTNET = "USDC:0xeb62eee3685fc4c43992febcd9e75443"
user_signed(
    "send_asset_perps_mainnet",
    {
        "type": "sendAsset",
        "destination": DESTINATION,
        "sourceDex": "",
        "destinationDex": "",
        "token": USDC_MAINNET,
        "amount": "25.5",
        "fromSubAccount": "",
        "nonce": NONCE,
    },
    sign_send_asset_action,
    True,
)
user_signed(
    "send_asset_spot_testnet",
    {
        "type": "sendAsset",
        "destination": DESTINATION,
        "sourceDex": "spot",
        "destinationDex": "spot",
        "token": USDC_TESTNET,
        "amount": "1",
        "fromSubAccount": "",
        "nonce": NONCE,
    },
    sign_send_asset_action,
    False,
)

# sendAsset from a sub-account back to its master (Exchange(vault_address=SUB).send_asset puts the sub-account in
# fromSubAccount; Kokoah signs it with the master's main wallet to move funds between accounts).
SUB_ACCOUNT = "0x4444444444444444444444444444444444444444"
user_signed(
    "send_asset_from_sub_account_testnet",
    {
        "type": "sendAsset",
        "destination": wallet_a.address.lower(),
        "sourceDex": "",
        "destinationDex": "",
        "token": USDC_TESTNET,
        "amount": "10",
        "fromSubAccount": SUB_ACCOUNT,
        "nonce": NONCE,
    },
    sign_send_asset_action,
    False,
)

# userSetAbstraction (Exchange.user_set_abstraction lowercases the user).
user_signed(
    "user_set_abstraction_unified_mainnet",
    {"type": "userSetAbstraction", "user": wallet_a.address.lower(), "abstraction": "unifiedAccount", "nonce": NONCE},
    sign_user_set_abstraction_action,
    True,
)
user_signed(
    "user_set_abstraction_disabled_testnet",
    {"type": "userSetAbstraction", "user": wallet_a.address.lower(), "abstraction": "disabled", "nonce": NONCE},
    sign_user_set_abstraction_action,
    False,
)

# Convert stablecoins: a spot IOC buy carries no builder (Hyperliquid charges builder fees on spot sells only); a sell
# carries it. Same order helpers as above.
l1(
    "spot_stablecoin_buy_no_builder_mainnet",
    order_wires_to_order_action([wire(USDT0_USDC, True, 25.0, 1.0005, {"limit": {"tif": "Ioc"}}, cloid=C1)]),
    True,
    expires_after=EXPIRES_AFTER,
)
l1(
    "spot_stablecoin_sell_builder_testnet",
    order_wires_to_order_action(
        [wire(USDT0_USDC, False, 12.5, 0.9995, {"limit": {"tif": "Ioc"}}, cloid=C2)], {"b": BUILDER, "f": 25}
    ),
    False,
    expires_after=EXPIRES_AFTER,
)

# setReferrer, exactly as Exchange.set_referrer builds it (an L1 action: agent keys can sign it).
l1("set_referrer_mainnet", {"type": "setReferrer", "code": "KOKOAH"}, True, expires_after=EXPIRES_AFTER)
l1("set_referrer_testnet", {"type": "setReferrer", "code": "KOKOAH"}, False)

# startFeeTrial: no SDK method yet. The action as Hyperliquid's app builds it (type, addBaseRate, crossBaseRate; rates
# toFixed(8) with trailing zeros trimmed), signed by the SDK's own L1 signing path.
l1(
    "start_fee_trial_mainnet",
    {"type": "startFeeTrial", "addBaseRate": "0.00012", "crossBaseRate": "0.0004"},
    True,
    expires_after=EXPIRES_AFTER,
    note="raw action (no SDK method); shape from Hyperliquid's app code",
)
l1(
    "start_fee_trial_top_tier_testnet",
    {"type": "startFeeTrial", "addBaseRate": "0.0", "crossBaseRate": "0.00028"},
    False,
    note="raw action (no SDK method); shape from Hyperliquid's app code",
)

# vaultTransfer, exactly as Exchange.vault_usd_transfer builds it (an L1 action; usd is USDC x 10^6). Trading keys may
# deposit into HLP only (vaults/hlp.ts), and withdraw from any vault the account holds.
HLP_MAINNET = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303"
HLP_TESTNET = "0xa15099a30bbf2e68942d6f4c43d70d04faeab0a0"
l1(
    "hlp_deposit_mainnet",
    {"type": "vaultTransfer", "vaultAddress": HLP_MAINNET, "isDeposit": True, "usd": 250_000_000},
    True,
    expires_after=EXPIRES_AFTER,
)
l1("hlp_deposit_testnet", {"type": "vaultTransfer", "vaultAddress": HLP_TESTNET, "isDeposit": True, "usd": 5_000_000}, False)
l1(
    "vault_withdraw_testnet",
    {"type": "vaultTransfer", "vaultAddress": VAULT, "isDeposit": False, "usd": 12_500_000},
    False,
    expires_after=EXPIRES_AFTER,
)

# tokenDelegate, as Exchange.token_delegate builds it (wei is HYPE x 10^8).
user_signed(
    "token_delegate_mainnet",
    {"validator": DESTINATION, "wei": 150_000_000, "isUndelegate": False, "nonce": NONCE, "type": "tokenDelegate"},
    sign_token_delegate_action,
    True,
)
user_signed(
    "token_undelegate_testnet",
    {"validator": DESTINATION, "wei": 1, "isUndelegate": True, "nonce": NONCE, "type": "tokenDelegate"},
    sign_token_delegate_action,
    False,
)

# cDeposit / cWithdraw (HYPE between spot and the staking balance): no SDK method; the SDK's generic user-signed path
# with the types from Hyperliquid's docs.
C_TYPES = [{"name": "hyperliquidChain", "type": "string"}, {"name": "wei", "type": "uint64"}, {"name": "nonce", "type": "uint64"}]


def c_signer(primary):
    return lambda wallet, action, is_mainnet: sign_user_signed_action(wallet, action, C_TYPES, primary, is_mainnet)


user_signed("c_deposit_mainnet", {"type": "cDeposit", "wei": 1_000_000_000, "nonce": NONCE}, c_signer("HyperliquidTransaction:CDeposit"), True)
user_signed("c_withdraw_testnet", {"type": "cWithdraw", "wei": 50_000_000, "nonce": NONCE}, c_signer("HyperliquidTransaction:CWithdraw"), False)

# Same scheme with a different signatureChainId (Arbitrum One, 0xa4b1), bypassing the SDK's 0x66eee default.
custom = {
    "type": "approveBuilderFee",
    "signatureChainId": "0xa4b1",
    "hyperliquidChain": "Mainnet",
    "maxFeeRate": "0.05%",
    "builder": BUILDER,
    "nonce": NONCE,
}
custom_types = [
    {"name": "hyperliquidChain", "type": "string"},
    {"name": "maxFeeRate", "type": "string"},
    {"name": "builder", "type": "address"},
    {"name": "nonce", "type": "uint64"},
]
vectors.append(
    {
        "name": "approve_builder_fee_chain_a4b1_mainnet",
        "kind": "userSigned",
        "isMainnet": True,
        "privateKey": KEY_A,
        "signer": wallet_a.address.lower(),
        "nonce": NONCE,
        "action": custom,
        "signature": sign_inner(wallet_a, user_signed_payload("HyperliquidTransaction:ApproveBuilderFee", custom_types, custom)),
    }
)

out = {
    "generator": "scripts/golden/generate.py",
    "pythonSdkVersion": version("hyperliquid-python-sdk"),
    "ethAccountVersion": version("eth-account"),
    "msgpackVersion": version("msgpack"),
    "note": "Fake public test keys. Python's to_hex() does not zero-pad r/s; compare signatures numerically.",
    "floatToWireChecks": {str(x): float_to_wire(x) for x in [100000.0, 0.001, 2500.5, 6721.3, 1.5, 180.25, 0.012345, 1000.0, 45.123]},
    "vectors": vectors,
}
json.dump(out, sys.stdout, indent=2)
sys.stdout.write("\n")
