# Brings the first visible window whose title matches -Title to the front.
#
# Windows will not let a program in the background take focus, so a Chrome
# window opened from the portal lands behind it and only flashes in the
# taskbar. Attaching to the input of whatever is in front for a moment is the
# standard way around that; nothing is typed or clicked.
param([string]$Title = 'Password Manager', [int]$WaitMs = 6000)

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Win {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);

  public static IntPtr Find(string pattern) {
    IntPtr found = IntPtr.Zero;
    var rx = new System.Text.RegularExpressions.Regex(pattern, System.Text.RegularExpressions.RegexOptions.IgnoreCase);
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      if (rx.IsMatch(sb.ToString())) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static bool Front(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    uint fg = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    uint me = GetCurrentThreadId();
    AttachThreadInput(me, fg, true);
    BringWindowToTop(h);
    bool ok = SetForegroundWindow(h);
    AttachThreadInput(me, fg, false);
    return ok;
  }
}
"@

$deadline = (Get-Date).AddMilliseconds($WaitMs)
while ((Get-Date) -lt $deadline) {
  $h = [Win]::Find($Title)
  if ($h -ne [IntPtr]::Zero) { [void][Win]::Front($h); exit 0 }
  Start-Sleep -Milliseconds 150
}
exit 1
