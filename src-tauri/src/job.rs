// A shell crash closes the only job handle and terminates the owned service tree.
#[cfg(windows)]
mod imp {
    use std::{io, mem, os::windows::io::AsRawHandle, process::Child};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::JobObjects::*,
    };

    pub struct Job(isize);
    impl Job {
        pub fn attach(child: &Child) -> io::Result<Self> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let job = Self(handle as isize);
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const _,
                    mem::size_of_val(&limits) as u32,
                ) == 0
                    || AssignProcessToJobObject(handle, child.as_raw_handle() as HANDLE) == 0
                {
                    return Err(io::Error::last_os_error());
                }
                Ok(job)
            }
        }
    }
    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0 as HANDLE);
            }
        }
    }
}

// Unix: the child was started as the leader of its own process group (see `prepare_child`);
// dropping the job kills that group. A crashed shell is also covered by the service itself,
// which stops when its stdin pipe closes.
#[cfg(unix)]
mod imp {
    use std::{io, process::Child};

    pub struct Job(i32);
    impl Job {
        pub fn attach(child: &Child) -> io::Result<Self> {
            i32::try_from(child.id())
                .map(Self)
                .map_err(|_| io::Error::other("Process id out of range"))
        }
    }
    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: killpg with a valid group id and signal has no memory effects; a gone group just returns an error.
            unsafe {
                libc::killpg(self.0, libc::SIGKILL);
            }
        }
    }
}

pub use imp::Job;
