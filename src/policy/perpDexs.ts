/**
 * HIP-3 perp dexes a Kokoah key may trade on mainnet. A HIP-3 dex's deployer sets its markets' oracle and mark prices,
 * their leverage and margin tables, and can halt and settle them: the mark a signer's price band trusts is only as
 * honest as the deployer. So mainnet signers trade only on the dexes pinned here (name and deployer, from HL
 * `perpDexs`), and only while the live `perpDexs` they fetch themselves still names the same deployer. Testnet (test
 * money) accepts every dex. Adding a dex is a deliberate change here (and a signer release), as for spot
 * (`spotPairs.ts`).
 *
 * @module
 */

/** A pinned HIP-3 dex. */
export interface PerpDexPin {
  name: string;
  fullName: string;
  /** Lowercase deployer address. */
  deployer: `0x${string}`;
}

/** Every HIP-3 dex on mainnet as of 2026-09-28 (HL `perpDexs`). */
export const VERIFIED_PERP_DEXS: { readonly mainnet: readonly PerpDexPin[] } = {
  mainnet: [
    { name: "xyz", fullName: "XYZ", deployer: "0x88806a71d74ad0a510b350545c9ae490912f0888" },
    { name: "flx", fullName: "Felix Exchange", deployer: "0x2fab552502a6d45920d5741a2f3ebf4c35536352" },
    { name: "vntl", fullName: "Ventuals", deployer: "0x8888888192a4a0593c13532ba48449fc24c3beda" },
    { name: "hyna", fullName: "HyENA", deployer: "0x53e655101ea361537124ef814ad4e654b54d0637" },
    { name: "km", fullName: "Markets by Kinetiq", deployer: "0x71f0019cc7fa79e4f42587fb7b9a817d8d2429ec" },
    { name: "abcd", fullName: "ABCDEx", deployer: "0x372c7f69d0ecc14f73f89bd8a7dfb41bdf29857c" },
    { name: "cash", fullName: "dreamcash", deployer: "0xffa8198c62adb1e811629bd54c9b646d726deef7" },
    { name: "para", fullName: "Paragon", deployer: "0x8888888c43cbb7e1c4132542e46831bffd866ed3" },
    { name: "mkts", fullName: "Markets By Kinetiq", deployer: "0x71f0019cc7fa79e4f42587fb7b9a817d8d2429ec" },
    { name: "io", fullName: "EntropyIO", deployer: "0x320c8988e3d1b5198f335802d7bfd2728a8fcac6" },
  ],
};

/**
 * Why a signer must not trade on HIP-3 dex `name`, given the live `perpDexs` entry it fetched itself (undefined when
 * HL doesn't list it), or undefined when it may.
 */
export function perpDexProblem(network: "mainnet" | "testnet", name: string, live: { name: string; deployer?: string | null } | undefined): string | undefined {
  if (!live) return `Unknown HIP-3 dex "${name}"`;
  if (network === "testnet") return undefined;
  const pin = VERIFIED_PERP_DEXS.mainnet.find((p) => p.name === name);
  if (!pin) return `HIP-3 dex "${name}" is not verified; Kokoah trades verified HIP-3 dexes only`;
  if (String(live.deployer ?? "").toLowerCase() !== pin.deployer) return `HIP-3 dex "${name}" has a new deployer; Kokoah trades it again once it is verified`;
  return undefined;
}
