/**
 * Published ASUS FZ expanded RC6 key: numeric format data, not a copied parser implementation.
 * Public source: https://github.com/cryptonek/illegal-numbers/blob/3c3ab6f38b6a4493730fb063ba12cb5c260b6a7e/FZkey.md
 * Attribution and licence status: THIRD_PARTY_NOTICES.md.
 * The automatic key is ASUS FZ only; CAE uses a different vendor key.
 */
export const FZ_DEFAULT_KEY: readonly number[] = Object.freeze([
  0x25d8d248, 0xe1502405, 0x56b5d486, 0x69213fe0,
  0xa22490ec, 0x01fdd9fa, 0x0681955f, 0x0fac202d,
  0xdac9eeb4, 0xf6024aba, 0xcd8b4cc6, 0x9f307c8e,
  0x4ab8fad7, 0x232f967d, 0x5e8666a3, 0xde966d4b,
  0xc64bfb1c, 0xea7fb092, 0x1a751a7e, 0x37e8f0bc,
  0x3359c8f3, 0x969ac22b, 0x610f5804, 0xd99d10e6,
  0xc58d54d6, 0x1f9aea8b, 0x8e388c1a, 0xe4f7d2ed,
  0x3e5da1f6, 0xedfe818a, 0x7252b016, 0xb503a170,
  0xc4128fb6, 0x2c93ceeb, 0x53539a6e, 0xdacf7668,
  0x3ab78e52, 0x8ee9d815, 0x7043f799, 0xc6a05dcf,
  0x727f1da2, 0x0dfd983b, 0x78c53872, 0x00945692,
]);

/**
 * Published ASRock CAE expanded RC6 key: numeric format data.
 * Public source: https://github.com/OpenBoardView/OpenBoardView/issues/162#issuecomment-2576037248
 * Attribution and licence status: THIRD_PARTY_NOTICES.md.
 * The CAE key must not be checked against the ASUS FZ parity table.
 */
export const CAE_DEFAULT_KEY: readonly number[] = Object.freeze([
  0x477fa6a2, 0xfb9b5e2b, 0x77bcac57, 0x2d7cef8c,
  0x69825182, 0xfa231194, 0x96ee6d48, 0x520a9b74,
  0x0619cb60, 0x95918dfb, 0x1c829771, 0x03f6655c,
  0xbba3b302, 0xf3cbcc66, 0xb42e9ac7, 0x417b37dd,
  0x34854b8c, 0xf95a9547, 0x7950401e, 0xc3271f83,
  0x0e7c9a6e, 0xcfa7f799, 0x616d9d05, 0x200ac08f,
  0x7cdb242f, 0x30d3bc5e, 0x2983cc29, 0x9da249c9,
  0x7509f015, 0x6632580e, 0x83247f04, 0x6525ed71,
  0x02fa242a, 0x47b12928, 0x7ed51b5d, 0xf69cd51b,
  0x66f24c77, 0x042856b9, 0x00e37970, 0x88b6624d,
  0x6826cd76, 0xd2a4c9fe, 0x2eff487a, 0x09648fae,
]);
