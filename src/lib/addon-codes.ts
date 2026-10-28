import crypto from 'crypto';

export type AddonDurationCode = '1Y' | '3Y' | '5Y';
export type AddonType = 'ADDITIONAL_USER' | 'ADDITIONAL_COMPANY';

/** One-way hashes only. Plaintext add-on codes are never shipped in source. */
const HASH_GROUPS: Record<string, string[]> = {
  ADDITIONAL_USER_1Y: [
    '7d469dee16e7969aa87309bcc41752602b8f59add61752f280259e6197e2fbcf',
    'db62e6c26aa13156ae1e3dfa656645e3a96cb39ce06779e43d1bd558a4d840d4',
    '13997c9d7b74ef9f1b9c97e790eca0173be989771fa86005b7afbf5d92a0b5f8',
    '08a8bf1606781f11226030290a608e3474840f7968d061cfb54fdc7ec2ca1074',
    'e9104ad51b73649c0cc0d6b33af4f9e27daa6e707bcfab8c899c5b5026b1402c',
    '7683da1e46ffef75ac22fd696dd0c6dee5703a588ec96d7c1a1546ff36b10f2d',
    'a185ebad3871c69f4c277c2dd07e4c70dd10d7845c1a562cb9b3e992012efb66',
    '454cdd09babb22104d04fd60b24636bfc8a6990c7d43138de676652a931b8b02',
    '3457ad515a66381ce7802da44ebaaf86a470ea8dd1acc46ad3ae7f6c9c1c9169',
    '73295a3176f5ea086e92a699255d9026174b84d7aef4c8dd8bc8b40a55a9a89d',
  ],
  ADDITIONAL_USER_3Y: [
    '9762d89e45c034b7254bd16e5df2276209ea686cd1652e6be5fc793f0cbcf3f2',
    '6a4c7b3de64675279c0e6097ce55155abd4e7c2b60b689d900cd275881d986ae',
    '381497671b058e40e128b14fb907a49b8252cc166222ac89133f0b9a8686064f',
    '5859e5f883385d93e416961b704217626157e3da5c714dcc9694d0551e3776b6',
    '8916743b01a50b506222f84c7745a7207ee2b00e8089d5a59261e122cef83537',
    'cebf1e479896216af85387ef569cc1e0e4351f5e032dbe69f6bb308e0cf8e04c',
    '947f310843693e0b20f9f3977133431850e4e214dd168a8fc0b2b562a69e0ee6',
    'd726b728ae6df23d0f1d1099a2fe20d39cb0cdf24ee3380ecb87c8e69845614a',
    '0b62a8ce20aa69d131e92cb5c4bb01fb5006683f2e4ea305ffc0565471ec4b84',
    '67a5b6dc47aa287af511bead517f5bed3f1ce547c80a88ef12c79666d34f801b',
  ],
  ADDITIONAL_USER_5Y: [
    '58c474b0f0f4d2d285868497ad0ed6c731242a47ed78c19753aa2b06024bbf82',
    '6d3f4f39a3ed121f25431981c1725fe6984559217ad6833ab6d76a8f79664ffc',
    'e194d89157d2af50b164b799ce06670cc16ab3063084c8e395192d0f5670e319',
    '88e8c046dca7aacb116c733091722ffa84e7975b71576a7357af45724cf22103',
    '6a0d7f1d0322cc46f95310cdb50c43edb4c11428a2f552d9b53e6f7aed88c0c2',
    '72b44a1ac04191c5c250182a1fa535432e6a0ae93d112388ac9c6c05fe96a689',
    'a744bc0d27f83672b5fc5e6bb9ffa8ba87f89cf02ccfcdf36c1fc7d5449caae3',
    'a8dfa0cd1855bb9ff5533c79a79490cac4e7b866e31d5c4c33b48a1a822eed7e',
    '313f3f55c035a3eb69a8305f4d5a8e2a90bc90baf6d02caab87ce347e35cbe5e',
    'ea911b2a22b74b278859c3f4c67fe04b25e63b9af9512787167a4f410f7f7006',
  ],
  ADDITIONAL_COMPANY_1Y: [
    '9c19f2e97542f6a90c04dfaf133700d48da354364dcfc991ca0f269f3706b25b',
    'c7d7dae267af92b0da3ef40fa72fe57862a0b96fb38450a75b20ff83c8edb0a6',
    '5d616ed33e09dc6fcc6c9190bd226ff037940b018e8990bc339b629df038689f',
    'dc16128feca664326072dc1fc2440d853fd7ccea88aea950f462ccabda184766',
    'b12164f263a7c545514bb9bcca0bb1a0a72fae4c7ab65d8bcf058c5b2c5761dd',
    '926fe5e3a9790fe24cfbce22b909fff22078369b6040cbf0a7efc7010dd16f5e',
    '67b0f4ab52ca3e4e6f891c28a75882fa85e53f2b9375bce321ad31d824d81593',
    '5334e7c632974a5cdb3237856940c70357aa3bf57dc593b09c4fee28cc069f7e',
    '56a1443be5da98d680d8a68c80c18483a22e2bb270b7b89d45edd8e222adff0b',
    '3ee9334e4e118ebaa8368a3e3910bba5161b7875d2f4a5cb4c897ef294f40aba',
  
  ],
  ADDITIONAL_COMPANY_3Y: [
    '6c8bd7dc9a74749448816a10e167d1a74cedd721c3c8744f159e6dae1fd3ff41',
    '0dc9350c88d95d7435986b454dfbc245be6bbe9c9d5387c49fe251d6b7ba5247',
    '697e5533e66009cf9e9703fae64c0c6603572de91579661178018e58406af1c8',
    '40949dcfe40dc1d4d981d2703eb5d3a313bc6bcbbf2ebc64722013a9427d0b02',
    'ed5364de7457fbf62c81c84eb6ab375782cf196754ecbc5a10bb56341987ee15',
    'b7cd6bc5be6b0c873193b2d70c65951f50d0c8317c8371307aa1b838ba94e740',
    'd14e8d9fe7b6cf856ebbd80b703f86dff02060cafa2ab7bcaefaec43b91cf989',
    '876bbcffea9615bccc5ebd9a04455ecb42b090cab5549188a7415d9c12911523',
    '54c058f244a3fa66fb524f30574a2704507405347fcca96524b127367d551f42',
    'e3cc4ad9b12a11b838963a9a3493ad268b945791a1c3646824f2d33cd0588056',
  
  ],
  ADDITIONAL_COMPANY_5Y: [
    '0cf5ff133fc9216efe31a09ac022f04c2d073f3d98ef5b34aba23c0a0ac695a7',
    'e8bd64b96a5b0c1edfdd3d8d6cb4afd893daf9eff45b6b00c83b205a06d1ef17',
    '939baa78676dfe6f1152cc401b0f6f8cb17a961eadb407c9a2d0409178ae41a7',
    '614eddc3a9d4b5094eeb5fa67fd5e2554831983bc08fede991903e82c4209c83',
    'b78d56285d171c62d5e58a652f8e0c4f82596d0fecf7acbd7ea159713784193f',
    '07cbec6d4f5dd3072b375d5995e70db51e885b59a99b92ae22f348a2c0707fdd',
    'd323b81590e9bc484b6249211cb2b8944381776e1ca346d783be444c32a139aa',
    '116d82bfd708ea7057cd6b99d5731fd7619be274effe5ba1b89d5045adf00071',
    '16731516bf5aefc27d068c8b47ad70534e20d0dd021223586cc0597672f7a51d',
    '5bd3733f9071b40f36ad7c9f69ca4de5250dc7866dece6701e2de61e13863387',
  
  ],

};

function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code, 'utf8').digest('hex');
}

const HASH_TO_ADDON = new Map<string, { addonType: AddonType; durationCode: AddonDurationCode }>();
for (const [key, hashes] of Object.entries(HASH_GROUPS)) {
  const parts = key.split('_');
  const addonType = `${parts[0]}_${parts[1]}` as AddonType;
  const durationCode = parts[2] as AddonDurationCode;
  for (const digest of hashes) HASH_TO_ADDON.set(digest, { addonType, durationCode });
}

export function verifyEmbeddedAddonCode(input: string) {
  const normalized = String(input || '').trim().toUpperCase();
  if (!normalized) return null;
  return HASH_TO_ADDON.get(hashCode(normalized)) || null;
}

export const EMBEDDED_ADDON_CODE_COUNT = HASH_TO_ADDON.size;
