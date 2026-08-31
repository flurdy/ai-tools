import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSessionMode } from "./session-mode.ts";

export default function sessionModeExtension(pi: ExtensionAPI): void {
	registerSessionMode(pi);
}

export { registerSessionMode } from "./session-mode.ts";
