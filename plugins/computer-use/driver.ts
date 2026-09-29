export const DRIVER = {
  version: "0.30.4",
  releaseUrl: "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.30.4",
  macTeamId: "YCK386LBJ7",
  assets: {
    darwin: {
      file: "cua-driver-rs-0.30.4-darwin-universal-binary.tar.gz",
      sha256: "a93d21bab914b2d854776f46f71a53bddd4e483ef762aeb74137d3ac306cbf65",
    },
    "linux-x64": {
      file: "cua-driver-rs-0.30.4-linux-x86_64-binary.tar.gz",
      sha256: "fff2016e0dea320df9be3aa52fc942c4ea4ca651df32cf3e950119bbc3097d29",
    },
    "linux-arm64": {
      file: "cua-driver-rs-0.30.4-linux-arm64-binary.tar.gz",
      sha256: "a77007a57ddac6f5b46a49fa9d7c39d9f22b461bd6b50af736b45946b0207875",
    },
  },
} as const;

export function assetFor(platform: string, arch: string) {
  if (platform === "darwin") return DRIVER.assets.darwin;
  if (platform === "linux" && arch === "x64") return DRIVER.assets["linux-x64"];
  if (platform === "linux" && arch === "arm64") return DRIVER.assets["linux-arm64"];
  return null;
}

export const SESSION_TOOLS = new Set([
  "browser_click", "browser_dialog", "browser_download", "browser_navigate", "browser_pointer",
  "browser_prepare", "browser_set_input_files", "browser_type", "click", "clipboard_read",
  "clipboard_write", "double_click", "drag", "end_session", "get_agent_cursor_state",
  "get_browser_state", "get_cursor_position", "get_desktop_state", "get_screen_size", "get_session",
  "get_window_state", "hotkey", "invoke_menu", "move_cursor", "press_key", "right_click", "scroll",
  "set_agent_cursor_enabled", "set_agent_cursor_motion", "set_agent_cursor_theme", "set_value",
  "set_window_frame", "start_recording", "start_session", "type_text", "verify_state",
]);

export const PID_REQUIRED_TOOLS = new Set([
  "click", "double_click", "right_click", "drag", "hotkey", "press_key", "scroll", "type_text",
  "set_value", "get_window_state", "invoke_menu", "verify_state", "set_window_frame",
  "bring_to_front", "kill_app",
]);

export const BLOCKED_TOOLS = new Set([
  "set_config", "install_extension", "install_ffmpeg", "check_for_update", "replay_trajectory",
]);

export const WHOLE_SCREEN = { key: "whole-screen", name: "the whole screen" } as const;
