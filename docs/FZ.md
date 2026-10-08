# FZ and CAE container validation

FZ/CAE exports may be decoded A!/S! text, plaintext zlib containers, or RC6 feedback containers. The extension selects the vendor's published default key; an explicit session key takes precedence for encrypted input. Keys decode individual files and do not activate the application. The key dialog can be skipped, leaving the rest of the workspace available.

Plaintext requires complete matching framing, rather than a two-byte zlib clue alone. Ciphertext may contain coincidental zlib bytes at offset 4; when its raw framing is inconsistent, the verified default/session-key path is tried. Once complete plaintext framing has selected that interpretation, damaged checksums or records remain errors.

The bounded splitter accepts compressed-length framing and the footer-derived spelling. Real exporters also store the decompressed content size, a content-stream forward pointer and the decompressed description size; these numeric sizes are checked. A zero-tag variant stores zero words around the content stream. Another variant stores the literal four-byte tag `PC6 ` in both size positions; those matching tags are distinguished from genuine numeric counts. Both zlib streams must consume their exact slices and pass Adler-32. No stream header is found by searching arbitrary data.

Some exports have an outer envelope: fixed bytes `0D 0F 3E 03`, a little-endian decompressed byte count and one complete zlib stream at byte 8. The reader checks its exact consumption, checksum and output length before interpreting the inner FZ/CAE container. Nested envelopes and output beyond 64 MiB are refused. The inner container still undergoes all normal cryptographic, framing, checksum and board-record checks.

The parser and diagnostic hook share framing and outer-envelope helpers. Hooks disclose whitelisted numeric layout/unit codes and redacted record shapes only. AppleDouble files have their own macOS resource-fork magic and return `WRONG_KIND`, without requesting an encryption key.

Diagnostic layout codes retain the existing integration numbering: 1–4 for
compressed-size spellings, 5 for footer framing, 6 for inflated-size metadata,
7 for paired `PC6 ` tags, and 8 for zero tags. These codes describe framing;
they do not replace stream integrity or record validation.

Validation uses original synthetic framing, checksum, collision and envelope regressions. A private expanded snapshot checked 2,552 FZ/CAE/FAZ paths: 2,455 FZ and 2 CAE files opened through this reader; 69 FAZ and one renamed `.fz` opened through FARC. One FZ contains a truncated second compressed stream. Eleven paths were macOS metadata and 13 disappeared while the owner reorganized the collection. Counts describe that snapshot, not a permanently fixed database. No proprietary files or keys from the private collection are distributed.
