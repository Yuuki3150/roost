#[cfg(windows)]
mod imp {
    use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        IsWindowVisible, SetForegroundWindow, ShowWindow, SW_RESTORE,
    };

    struct SearchState {
        target_pid: u32,
        found: Option<HWND>,
    }

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let state = &mut *(lparam.0 as *mut SearchState);
        if IsWindowVisible(hwnd).as_bool() {
            let mut window_pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut window_pid));
            if window_pid == state.target_pid {
                state.found = Some(hwnd);
                return BOOL(0);
            }
        }
        BOOL(1)
    }

    fn find_window(pid: u32) -> Option<HWND> {
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

    pub fn focus_pid(pid: u32) -> bool {
        match find_window(pid) {
            Some(hwnd) => unsafe {
                let _ = ShowWindow(hwnd, SW_RESTORE);
                let _ = SetForegroundWindow(hwnd);
                true
            },
            None => false,
        }
    }

    pub fn window_title_for_pid(pid: u32) -> Option<String> {
        let hwnd = find_window(pid)?;
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
    pub fn window_title_for_pid(_pid: u32) -> Option<String> {
        None
    }
}

pub use imp::{focus_pid, window_title_for_pid};
