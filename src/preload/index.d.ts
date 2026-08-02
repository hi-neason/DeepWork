import type { DeepWorkApi } from "./index";

declare global {
  interface Window {
    deepwork: DeepWorkApi;
  }
}

export {};
