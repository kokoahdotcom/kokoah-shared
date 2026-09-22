# Golden signing vectors

`generate.py` uses the official Hyperliquid Python SDK (`hyperliquid-python-sdk`, pinned to 0.24.0 when these vectors
were produced) to sign a fixed set of actions with fixed, obviously fake keys and fixed nonces. The output,
`test/golden/vectors.json`, is checked in. `test/golden.test.ts` asserts that this library produces:

- the same L1 `connectionId` (msgpack + nonce + vault + expiresAfter hash) and the same `{r, s, v}` for every L1 vector;
- the same `{r, s, v}` for every user-signed vector (approveAgent, approveBuilderFee, withdraw3), via our typed-data
  builders and via the SDK wrapper;
- byte-identical wire actions from `compileAction` for the vectors that correspond to an intent.

The keys (`0x0123…cdef`, `0xfedc…3210`) are public test constants. Never fund them. No network access is involved.

## Regenerate

Keep the Python virtualenv **outside** the repository:

```sh
python3 -m venv /tmp/kokoah-golden-venv
/tmp/kokoah-golden-venv/bin/pip install hyperliquid-python-sdk==0.24.0
/tmp/kokoah-golden-venv/bin/python scripts/golden/generate.py > test/golden/vectors.json
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm test golden
```

If a vector stops matching after an SDK upgrade, diff the `action` objects first (key order, trailing zeros, lowercase
hex), then `connectionId`, then the signature. Note that Python's `to_hex()` does not zero-pad `r`/`s`, so the test
compares them as integers.
