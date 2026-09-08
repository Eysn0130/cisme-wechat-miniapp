import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";

const source = resolve(process.cwd(), "../cisme-home-prototype/public/assets/cisme");
const destination = resolve(process.cwd(), "apps/miniprogram/assets/cisme");
const expected: Record<string, string> = {
  "cisme-home-background-v1.webp": "5e3b909bf511e86f4053d320093f9876a5a3e3ae0adedc3fb07cd5d03701482f",
  "community-card-care-flatlay-v2.webp": "e8e625c8b83a39fa896149a49d64ea34d39a55eca0dc6b91c40b563348e1b684",
  "community-card-care-journal-v2.webp": "5658bc16505167279f430099aa7528404bce32a294a74f1452dc243e3d400811",
  "community-card-glossy-hair-v1.webp": "641cd60fd7db26311723d09ac8b44f3aa1ac32d276b0dc8c87767f9ca920fb37",
  "community-card-hair-day3-v1.webp": "c188a397a046fa70293fb52c5438745ce2a9e88bb7b71ccc8e0e5ad9dbcf404f",
  "community-card-hair-profile-v1.webp": "95b8420690b03d1d0357a73e5c428bd7f9e86ba5b31f6b1557cc4546a1fbea6b",
  "community-card-mirror-roots-v2.webp": "c116ecf40767bb3bcaa999d44cba74b5734ab2aa9d6caba087ef06db3560497f",
  "community-card-purple-bottle-v1.webp": "4bff10496464c19b7e0396b7c6534f6ac64af5abbc1bc97cc799b65ecb64cb8a",
  "community-card-scalp-massage-v2.webp": "46bb083a9185e9915916dfc0e32e96a91c0778aff485fab526f4354e70e5d7a9",
  "community-hero-scalp-ritual-v1.webp": "0aeccb3735588204044390ac23ce431b08f2f6ca9b808b23ad51dedc121ddd00"
};

const expectedAvatars: Record<string, string> = {
  "avatar-ali-v1.webp": "4b62a2303c78f8dea6f015b0dc60b05d8d04a1a15d64b4cbb960633bb9134e09",
  "avatar-bairimeng-v1.webp": "6ec7af83b65081c6e88b120918526bd1689f09e1dbe90f032dcc93151679f6a0",
  "avatar-jiajing-v1.webp": "7f749a31ee8255f1aba20b89c1aee916ab43a4e59a96fa06d52e568a88214060",
  "avatar-jingyu-v1.webp": "0bce92520780e7b034837ef3793a47c58645a2cff31767721b0ede5c50989ede",
  "avatar-luna-v1.webp": "41f7d75d82c54d137bf802e4a938b85744916b1773780e7ab3031d6b83b2fb6d",
  "avatar-muguang-v1.webp": "fe9c02af0195c755cb25bceed84d41cc79ae6963e4b143f2516d886399b053f8",
  "avatar-mujin-v1.webp": "cb87b64a6871b994ad122e6f31dd03a8887052670df028fd8df5e7df45ac64dd",
  "avatar-nanfeng-v1.webp": "12fb4095044d2bd3116f296e8dd3492d34f7ad58e4d370d7966d2cc5bc3e7c02",
  "avatar-yurou-v1.webp": "fb0a88e7e3d047e9eb62a2976c10ec8ce56273f5633dd62b62f3a5ba4c616f61",
  "avatar-zhihe-v1.webp": "72bd8f6398154074068a2e3fe7b2ed22fbc91e819f3f13ff75675d090cab9cb1"
};

async function syncFrozenSet(sourceDirectory: string, destinationDirectory: string, hashes: Record<string, string>) {
  await mkdir(destinationDirectory, { recursive: true });
  const actual = (await readdir(sourceDirectory)).filter((name) => name.endsWith(".webp")).sort();
  if (actual.join("\n") !== Object.keys(hashes).sort().join("\n")) throw new Error(`ASSET_SET_DRIFT:${sourceDirectory}`);
  for (const name of actual) {
    const input = resolve(sourceDirectory, name);
    const bytes = await readFile(input);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== hashes[basename(input)]) throw new Error(`ASSET_HASH_DRIFT:${name}`);
    await copyFile(input, resolve(destinationDirectory, name));
  }
}

await syncFrozenSet(source, destination, expected);
await syncFrozenSet(resolve(source, "avatars"), resolve(destination, "avatars"), expectedAvatars);
console.log(`synced ${Object.keys(expected).length + Object.keys(expectedAvatars).length} frozen CISME assets with verified SHA-256`);
