import { execFile } from "node:child_process";
import { type GlobalSettings, type WindowsContext } from "../shared/types";

const activeWindowScript = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win32ActiveWindow {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
$handle = [Win32ActiveWindow]::GetForegroundWindow()
$builder = New-Object System.Text.StringBuilder 512
[void][Win32ActiveWindow]::GetWindowText($handle, $builder, $builder.Capacity)
$pidValue = 0
[void][Win32ActiveWindow]::GetWindowThreadProcessId($handle, [ref]$pidValue)
$processName = $null
if ($pidValue -gt 0) {
  try { $processName = (Get-Process -Id $pidValue -ErrorAction Stop).ProcessName } catch {}
}
[PSCustomObject]@{
  title = $builder.ToString()
  processId = [int]$pidValue
  processName = $processName
} | ConvertTo-Json -Compress
`;

export class WindowsContextService {
  async capture(settings: GlobalSettings): Promise<WindowsContext> {
    if (!settings.windowsContextEnabled) {
      return emptyWindowsContext(false);
    }

    if (process.platform !== "win32") {
      return {
        ...emptyWindowsContext(true),
        error: "Windows context is only implemented on Windows.",
        capturedAt: new Date().toISOString(),
      };
    }

    try {
      const raw = await execPowerShell(activeWindowScript);
      const parsed = JSON.parse(raw) as { title?: string; processId?: number; processName?: string };
      return {
        enabled: true,
        activeWindowTitle: settings.activeWindowTitleEnabled ? parsed.title || null : null,
        activeProcessName: parsed.processName || null,
        activeProcessId: typeof parsed.processId === "number" && parsed.processId > 0 ? parsed.processId : null,
        capturedAt: new Date().toISOString(),
        error: null,
      };
    } catch (error) {
      return {
        ...emptyWindowsContext(true),
        capturedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Active window detection failed.",
      };
    }
  }
}

export function emptyWindowsContext(enabled = false): WindowsContext {
  return {
    enabled,
    activeWindowTitle: null,
    activeProcessName: null,
    activeProcessId: null,
    capturedAt: null,
    error: null,
  };
}

function execPowerShell(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}
