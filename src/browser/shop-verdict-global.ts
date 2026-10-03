// Browser entry for site/little-shop/verdict.js: puts shopVerdict on window.JNJShopVerdict. Built by
// scripts/uc13/little-shop.ts; never edit the built file.

import { labelRecords, shopVerdict } from "./shop-verdict.ts";

Reflect.set(globalThis, "JNJShopVerdict", { labelRecords, shopVerdict });
