import { defineWithTypes } from "gunshi";
import type { EdenExtensions } from "./options";

export const defineCommand = defineWithTypes<{
  extensions: {
    eden: EdenExtensions;
  };
}>();
