import crypto from 'crypto';

export interface EmbeddedActivationCode {
  planCode: 'STARTER' | 'BUSINESS' | 'PROFESSIONAL';
  durationCode: '1Y' | '3Y' | '5Y';
}

/**
 * Production activation registry.
 *
 * IMPORTANT:
 * - Plain activation codes are intentionally NOT stored in the desktop source.
 * - Only SHA-256 digests are embedded here.
 * - The frontend never receives the registry.
 * - This is a local verification layer. It is not a substitute for a
 *   central licensing server, because code executing on a customer's PC
 *   can ultimately be patched by a sufficiently capable local attacker.
 *
 * This desktop build intentionally uses this registry directly; a future
 * central-license build should be a separate deployment configuration.
 */
const HASH_GROUPS: Record<string, string[]> = {
  STARTER_1Y: [
    'd8a4defa440e48c8bd36553864e3a713437c2a11443e7496c2492b161522c1b1', '8b4549cb8901a5e17c470d8a0fbfdaf3e1d883c6528cee05b1cb890fff4d6732',
    '54a2e3a2c230a1030f89e649bd2b410b19f53a1cd47a6d28d99f02723c324e4f', '7b44885df4f1d7d61e77bd7487d860bfb8b6769f7760ea3abaee7c8815cdbabc',
    'deccb32c3f310e50bbacab2616a257df22f3306340c34ed2e4f58e29ed140674', '0ad43dcb8bb16d91c79bb3f2f0ff3d5522e491578a9919525b5f43613445d39c',
    'd5f682934ee16868c2ea8046d3a7a3382cdcfccc07188d5ead04bece352aa4d6', '154ae531cd62631857dd0d7e7b7d68facabda1cdee288495e29655c328e32a22',
    'dfff9350186e6bb6983f6ea0529b710055654172776cd41499179154c3d60a65', '520380a9bb21d7a3f18b176b5102aee5f92f0d9e1460292a93590f76aae7b7f8',
  ],
  STARTER_3Y: [
    '923d2b5273cf2a7df2df5c34753f8f037dbb8a5f6868189c4990276b40b92da8', '287a6fa19f46ed23194237704d9958f12dd8c6c5431188250f40edb33ea7a80d',
    '680e0ad9112a27ba5db082d117e86142bdbefed88d3a306a57b0ed437dbaf99a', '403ff6a30065f87e410ca68304e3e330e4f1291672b9abd4c83052bcebbf3917',
    '0a33b3123e4934b2048025168e529926329367d2c9283f7b61579822636d3575', 'd4b790d353b522ae7593b855b5be47b7f1eeafcd2474a0764562d11c3dc5a01e',
    '4870f96e47457e3d2f459189665039f70f4771a27950444a4033973de84d29e2', 'fb7169a5e1eddacfb56f06fdb665212153f311af39248753a9917e2a7a37b1d2',
    '7ebc0336339640164077c05e0e1493e8755106732f4e511540102d9ae56601f9', '6f50adaf02d87a51ee351cd40e2e46d95d20e74488d98d6fec4046ae5e374053',
  ],
  STARTER_5Y: [
    '1acc49f4751c84f4714576c7e6096323949b89ae3a74eb39b52d370f69fd78c2', '81e36e2cc6b7c019f53ee09d1d542fe3cc60364e3dc504bc5185531ec22aa6e2',
    '716d53d0021884a79c89edb080cf0eeca8260d5cd1ccf61141e4fb9fb687e16e', '51093af5ab5d1724f7d172b4a5e168f3bcd487d46a1c6fb96e91d4dd79135361',
    'a4272d4545bbda43713cb654b1e6008460820a66d08a059a7df92e84bd3bc382', '33150195e99b64b8ba6d26bd2a1e941b508ca32fbd43c7a7d9ffcbbc082d00e6',
    '7510514c8860bfbafdb280f9bc00e3bf5ca2e75cf25d4deb5d6015ac794f59d5', '7de64016ad693fb237da2eacd2d1d6ae3f64396cde883f29a63c9de96ef64243',
    '1a2ce3f183b24677081f085ecad129f167a4378dfb605a0dbe724c4d1677f70a', '283ccfa296e3c684bc7bb0ac28556ec7ffe8580dfe26429328872fc541d484eb',
  ],
  BUSINESS_1Y: [
    '741e5c175abafa373d121001e8c2a0db92f11a7478ff178f4e05596b8aa35930', 'b12f52523e88bacc170330b9ce6e14f6c40056824267d7f06647a851353e3efb',
    'd9707b53c13cb7d7ec59131a7c2e68a6c5dcc518d7f8f9fe0e850688718a2e96', 'dff99b8d287ce72c4a20801eddf1f7787aaccd16798ba1c41818fdc4e5ae9392',
    '662d5933a5fa01d987c1748ae4c9ebb2f8982b11eb413e917835098c7e0a8241', 'a484bbefbf2cb3c7cb401d397733d3042109d13cb89aa1de19c206bb26d2531c',
    '047096917d25d0ef03cfdffdfb8477339d3ebf3a95d2d2f99d10f79273ae53d8', 'bb458ac5ea2d251b89ca7e43c3141d3422ae726a08be7ceb17fb2111f85434ae',
    '0efc3fee5c96be96b95a5ea923ba0dc7bcdeb7da27efa0a38183f3aaf3901f9c', '7121f0a28c72f7b117960675bcd8eb419b0641bf9df3f7244db3e495e7720595',
  ],
  BUSINESS_3Y: [
    'b9df24400e24de4db83f7971acfa01ec8e217126b662268be141dcbc80e1dc67', '898c9b9c3055fc1e10cd385fad5dd54825c27da85d7bbd670326359f0a59e9ad',
    '2ec43f583da32b3f902aefeb3988d0fe8c3f451c7104faa18e76d58b0b0bf8d4', '2f9908612076977137dc3bbd7195c096511827101550be9b56f2d30dcd74c3bf',
    '430357cb2cffc087db889bcd519d768a3842a2628e8b2ee7f474e4aee071e975', '7d7c9c19c2a1f86c2131f459ffedda21a1266eec03af570b9e697ba58e08ea5b',
    'd3f17cb98db829aa86281590c36a8e3c500a818cbfb9993f526857472564629a', '47dccf3dc4995fee0dfedb656fb21a13338f254227fd27855c4a6d4f70e7d315',
    '4b80adc78f4ac86ebfb3dfa92148f8ee321401d1f45ae3751bb89036cafd194b', 'c5bfb89637dae72d55b5bcb7b47979f2fcea5442999f97a5e358ebfa1831add6',
  ],
  BUSINESS_5Y: [
    '5e65ddb5bb275ea69a00ecb27ef3dafef7b50031f5cbba3ae657a1f59aa46fba', '57fd6da640f6edb30efaf2400bb33cde20dd2c2ba36133d42b0b61439a16eaa9',
    '4b5aaf1dbd2fc7dd3001d2c60b6c4b69ea9dcca54bccef47f988b40d38b6feba', '7f28c6ddfdfbcb7eea1bf805772a3bd4dfde5787e5721c2b5a33db7ffa3b434d',
    '5b4e79967cec802fd20488f766ef075e823a9d7d426b10f1d2c3954c4ced3ec9', 'a705b3f218f42dbd9c63bad613336a09291942f72389c70461c7ca5234aa7312',
    '8a745aa94a251a4e2120635dba9bcdd2927314e61f52499faac6b990a246901c', '46ee00994961d0e82d19c8ef27d0f92e3b1c6644b53b022476e5cd5f3c580484',
    '351d13dbd7ba86847675af37d680d057437eb484129573318174487f6417c35c', '6a538f74eb626076b38dfd1fb9511630304c8521559282059df6834331b7c793',
  ],
  PROFESSIONAL_1Y: [
    '06f70b5012bed088a243e553fc9a8a070d6e6cf5e0e880ad3f85e39ee6c3af94', '44c561e9c88802b585b8405e5df78b53505299f9ed8fd53f4c33217a94635e1a',
    '6e5c0d63d26f86b37b337a4e454b08ffe6fba76033c1a194b97f40b2bc621b7f', '8ad93a43e81ecb8e60a4ee7eb14c60d8110b25d5c2114442314522abf2f1f28a',
    '477accd089d1b835e2a7a7190824278cd80e41c4d0075a9d425449a35d7d6b7a', '2f5c8f1e40b2efc887fce8b037d8b7886cb49d7492b5d50e500f4a9d347ba964',
    'a218826236bcccbf77501313b2356af297d83b0e004c69a2a6e78595e64305cb', '3efff94851fdec5bc46c4b01f561cbdfa6fea29405bcf4057364cf3dfb59586c',
    '10b9001d822032fc5a6c95aabc951d9ddad50a08e85377d23b0b40369f4fb2cd', '0ac80576040ef1368f4d3ba8da637b15b6f809603e618035a2cfeadb5a812d75',
  ],
  PROFESSIONAL_3Y: [
    '9ec3087d5493d740ef97d7bd145b3bdcc198e639d9494582253a48bf2572f76f', '73136984410746accc26403963b1704fe137e8b7c929a5181c2c0e7c4d01ab3b',
    '8de1fbd0d803d8a47bf23d1a44daa03198bd6151dfeb6ce2557e31928d77fd10', 'b48c2f44d9e6f3297313de3a9cb8a51f3b4029c18baf9b9221911ebbdfba91cf',
    '8f662d2b7a228faf28cdecb327e86573351efe43c196a0b6bb292d870abe3889', 'e2892bb1422ee0a99f38b538ed35b8db433562ca29305cef32fa80ccf37f66f1',
    '6402e3bbe7dcb22bb335faf1ca3e2dd3b2c13dcd727fbb24f5832bce89f07dad', 'ae29c63e2037c1705046aac390b4d93bba9b2ff23f353c887f21974eed071d31',
    '5ce8815d052deb54e33e532df173d0c23447b6172dffab3b5222936e69f5ae8f', '06b327da8fd56c64ead613688494f9216f64f75f2f3d594cac309d5228187061',
  ],
  PROFESSIONAL_5Y: [
    'c0bd17481196963c5274088fd05a11fe6cef69c98d06a2e727201e95d61dc236', '062503554ed831d6b8817cb5a681c3c4b081e8f4cdb03197ae92a6a364336f7d',
    '4d73e7f3eff38cbb6a3b09e3f7c5e14e7f5759afa742dc5047b7b544572602e7', '27cb91c23e03a4f7688a1d9470052bb5e785c7db9396e2d22b03ab54af8b8946',
    '8e9d4754224d8fdaf0534d1eba4ce5086140729c89c0b88f238035149b129d6d', '21839f04d3c1da9e0a0c903d0f4c90d8531663ef9710946225adcf30c57c5754',
    '1dc7ca94fb5c77634365b8b4e1c6f59b3fad1b95911400466ea8f40c4f8ae233', '602cc9cd165f6e07eb98226d8b87db0b64e727da9620352578f21774babc6386',
    '4c1ae07501c5ba45fad3d84ef75121273b2f80fea3efc51f725fb7a53882a877', 'dd3e6940678f31b5341999e4478699d0ccee6c884d32ebb3e5d7a7531f33b5fb',
  ],
};

// Earlier fixed/reusable codes from the B-MAX master register. Plaintext values are never shipped.
const LEGACY_HASH_GROUPS: Record<string, string[]> = {
  LEGACY_STARTER_1Y: ['e4711854821bcb031a3a049f74c43f4cdb1dd768a489f18f8b66a16ab8e8b431'],
  LEGACY_STARTER_3Y: ['b760a29f0579c79acf50223272cf27d7701a1998da17d6d22c400f3a7004e515'],
  LEGACY_STARTER_5Y: ['3dce1a6c2b56c4161fb179bea96a8aa2e86922cfff09e92f3c6f07b0a4de4ed2'],
  LEGACY_BUSINESS_1Y: ['47641010d1f2f8ec599d02be3ef10614d4575839f6d288508dac8a6d4b4ff802'],
  LEGACY_BUSINESS_3Y: ['ab8c3127bf07c09b64e41f3c1e722e78a44b88ae6a7789656f8de77cc208162d'],
  LEGACY_BUSINESS_5Y: ['c0db3cfe5088ce174d471700d48933045d683be83c28b7a361946e1d67ab48a1'],
  LEGACY_PROFESSIONAL_1Y: ['c2e4d3352ee81a03156d4846ef39697989e259afbe1100ab360d708c3aca8e0c'],
  LEGACY_PROFESSIONAL_3Y: ['9cd536cd9b81c0e7cf25a2a8448c64f3616a4b61ca32a5ebe6824f02657a0561'],
  LEGACY_PROFESSIONAL_5Y: ['65e1079045b8946451028e08c6a23a22271440db5215b4f92a0efdaf9f7f2a5e'],
};

function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code, 'utf8').digest('hex');
}

const HASH_TO_PLAN = new Map<string, EmbeddedActivationCode>();
for (const [key, hashes] of Object.entries(HASH_GROUPS)) {
  const [planCode, durationCode] = key.split('_') as [
    EmbeddedActivationCode['planCode'],
    EmbeddedActivationCode['durationCode']
  ];
  for (const digest of hashes) HASH_TO_PLAN.set(digest, { planCode, durationCode });
}
for (const [legacyKey, hashes] of Object.entries(LEGACY_HASH_GROUPS)) {
  const key = legacyKey.replace(/^LEGACY_/, '');
  const [planCode, durationCode] = key.split('_') as [
    EmbeddedActivationCode['planCode'],
    EmbeddedActivationCode['durationCode']
  ];
  for (const digest of hashes) HASH_TO_PLAN.set(digest, { planCode, durationCode });
}

export function verifyEmbeddedActivationCode(input: string): EmbeddedActivationCode | null {
  const normalized = String(input || '').trim().toUpperCase();
  if (!normalized) return null;
  return HASH_TO_PLAN.get(hashCode(normalized)) || null;
}

export const EMBEDDED_ACTIVATION_CODE_COUNT = HASH_TO_PLAN.size;
