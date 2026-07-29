#[cfg(windows)]
mod imp {
    use std::collections::HashMap;
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, EnumWindows, GetForegroundWindow, GetWindow, GetWindowTextLengthW,
        GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetForegroundWindow,
        ShowWindow, GW_OWNER, SW_RESTORE,
    };

    /// How far up the process tree to look for a window. Agents nest a few
    /// levels deep (terminal → shell → agent → hook shell → node), and a bound
    /// keeps a corrupt parent link from turning into a long walk.
    const MAX_ANCESTRY_DEPTH: usize = 8;

    struct SearchState {
        target_pid: u32,
        found: Option<HWND>,
    }

    /// A window worth jumping to: on screen, top-level rather than a dialog or
    /// tool window owned by another, and actually captioned. Plenty of processes
    /// keep invisible or owned helper windows around; landing on one of those
    /// would look exactly like the jump doing nothing.
    unsafe fn is_main_window(hwnd: HWND) -> bool {
        IsWindowVisible(hwnd).as_bool()
            && GetWindow(hwnd, GW_OWNER).is_err()
            && GetWindowTextLengthW(hwnd) > 0
    }

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let state = &mut *(lparam.0 as *mut SearchState);
        if is_main_window(hwnd) {
            let mut window_pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut window_pid));
            if window_pid == state.target_pid {
                state.found = Some(hwnd);
                return BOOL(0);
            }
        }
        BOOL(1)
    }

    fn window_of(pid: u32) -> Option<HWND> {
        let mut search = SearchState {
            target_pid: pid,
            found: None,
        };
        unsafe {
            let _ = EnumWindows(
                Some(enum_proc),
                LPARAM(&mut search as *mut SearchState as isize),
            );
        }
        search.found
    }

    /// pid → parent pid for every live process, from a single snapshot. Taking
    /// one snapshot and walking the map beats re-snapshotting per level.
    ///
    /// Windows recycles pids, so a parent link can in principle point at an
    /// unrelated newer process. Requiring a captioned window at the destination
    /// and bounding the depth keeps the blast radius to "focused the wrong
    /// window", which the user can see and undo.
    fn parent_map() -> HashMap<u32, u32> {
        let mut map = HashMap::new();
        unsafe {
            let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
                return map;
            };
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if Process32FirstW(snapshot, &mut entry).is_ok() {
                loop {
                    map.insert(entry.th32ProcessID, entry.th32ParentProcessID);
                    if Process32NextW(snapshot, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = windows::Win32::Foundation::CloseHandle(snapshot);
        }
        map
    }

    /// Finds the window that represents a session, starting from whichever
    /// process the bridge happened to run under.
    ///
    /// That starting process is almost never the right answer: hooks run in a
    /// windowless shell spawned by the agent, which itself may be a child of the
    /// terminal — or of a GUI app like the Claude desktop client or Cursor. So
    /// walk up until a process owns a real window. Matching on process *names*
    /// instead (the old approach) picked the first thing called `powershell.exe`,
    /// which was the hook's own invisible shell.
    fn window_in_tree(start: u32) -> Option<(u32, HWND)> {
        if let Some(hwnd) = window_of(start) {
            return Some((start, hwnd));
        }
        let parents = parent_map();
        let mut pid = start;
        for _ in 0..MAX_ANCESTRY_DEPTH {
            let parent = *parents.get(&pid)?;
            if parent == 0 || parent == pid {
                return None;
            }
            if let Some(hwnd) = window_of(parent) {
                return Some((parent, hwnd));
            }
            pid = parent;
        }
        None
    }

    /// Windows refuses `SetForegroundWindow` from a process that doesn't own the
    /// current foreground window. The overlay usually does own it (the user just
    /// clicked it), but not when the jump comes from the global hotkey — so fall
    /// back to briefly sharing the foreground thread's input queue, which lifts
    /// the restriction for the duration.
    unsafe fn force_foreground(hwnd: HWND) -> bool {
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        if SetForegroundWindow(hwnd).as_bool() {
            return true;
        }

        let foreground = GetForegroundWindow();
        if foreground.0.is_null() {
            return false;
        }
        let fg_thread = GetWindowThreadProcessId(foreground, None);
        let this_thread = GetCurrentThreadId();
        if fg_thread == 0 || fg_thread == this_thread {
            return false;
        }

        let _ = AttachThreadInput(this_thread, fg_thread, true);
        let ok = SetForegroundWindow(hwnd).as_bool();
        let _ = BringWindowToTop(hwnd);
        let _ = AttachThreadInput(this_thread, fg_thread, false);
        ok
    }

    pub fn focus_pid(pid: u32) -> bool {
        match window_in_tree(pid) {
            Some((_, hwnd)) => unsafe { force_foreground(hwnd) },
            None => false,
        }
    }

    /// The pid whose window a session should jump to. Resolved while the agent
    /// is still running, because the hook's process is long gone by the time
    /// anyone clicks the row.
    pub fn resolve_host_pid(pid: u32) -> u32 {
        window_in_tree(pid).map_or(pid, |(resolved, _)| resolved)
    }

    pub fn window_title_for_pid(pid: u32) -> Option<String> {
        let (_, hwnd) = window_in_tree(pid)?;
        unsafe {
            let len = GetWindowTextLengthW(hwnd);
            if len <= 0 {
                return None;
            }
            let mut buf = vec![0u16; len as usize + 1];
            let copied = GetWindowTextW(hwnd, &mut buf);
            if copied <= 0 {
                return None;
            }
            Some(String::from_utf16_lossy(&buf[..copied as usize]))
        }
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn focus_pid(_pid: u32) -> bool {
        false
    }
    pub fn resolve_host_pid(pid: u32) -> u32 {
        pid
    }
    pub fn window_title_for_pid(_pid: u32) -> Option<String> {
        None
    }
}

pub use imp::{focus_pid, resolve_host_pid, window_title_for_pid};
