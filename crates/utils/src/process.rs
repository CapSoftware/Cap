use std::io;
use tokio::process::{Child, Command};

pub fn spawn_with_piped_output(mut command: Command) -> io::Result<Child> {
    #[cfg(windows)]
    let (stdout, stderr) = {
        use std::os::windows::io::OwnedHandle;

        // Stdio::piped uses overlapped Windows handles. Tokio reads those synchronously,
        // which can abort the entire app if Rust observes an unfinished I/O operation.
        // std::io::pipe uses CreatePipe and supplies synchronous handles instead.
        let (stdout_reader, stdout_writer) = io::pipe()?;
        let (stderr_reader, stderr_writer) = io::pipe()?;
        let stdout = tokio::process::ChildStdout::from_std(std::process::ChildStdout::from(
            OwnedHandle::from(stdout_reader),
        ))?;
        let stderr = tokio::process::ChildStderr::from_std(std::process::ChildStderr::from(
            OwnedHandle::from(stderr_reader),
        ))?;
        command.stdout(stdout_writer).stderr(stderr_writer);
        (stdout, stderr)
    };

    #[cfg(not(windows))]
    command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let child = command.spawn()?;
    // Command retains write handles that would prevent EOF after the worker exits.
    drop(command);

    #[cfg(windows)]
    let child = {
        let mut child = child;
        child.stdout = Some(stdout);
        child.stderr = Some(stderr);
        child
    };

    Ok(child)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, process::Stdio, time::Duration};
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

    const CHILD_MODE: &str = "CAP_UTILS_PIPE_TEST_CHILD";
    const LINE_COUNT: usize = 20_000;

    #[test]
    fn pipe_test_child() {
        let Ok(mode) = std::env::var(CHILD_MODE) else {
            return;
        };

        if mode == "wait" {
            let mut stdout = std::io::stdout().lock();
            writeln!(stdout, "ready").unwrap();
            stdout.flush().unwrap();
            loop {
                std::thread::sleep(Duration::from_secs(1));
            }
        }

        let stderr = std::thread::spawn(|| {
            let mut stderr = std::io::stderr().lock();
            for frame in 0..LINE_COUNT {
                writeln!(stderr, "log:{frame}:{}", "x".repeat(257)).unwrap();
            }
        });
        let mut stdout = std::io::stdout().lock();
        for frame in 0..LINE_COUNT {
            writeln!(stdout, "progress:{frame}").unwrap();
        }
        stdout.flush().unwrap();
        stderr.join().unwrap();
        if mode == "fail" {
            std::process::exit(17);
        }
    }

    fn child_command(mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "process::tests::pipe_test_child",
                "--nocapture",
                "--quiet",
            ])
            .env(CHILD_MODE, mode)
            .stdin(Stdio::null())
            .kill_on_drop(true);
        command
    }

    async fn check_output(mode: &str, expected_exit: i32) {
        let mut child = spawn_with_piped_output(child_command(mode)).unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let mut progress = String::new();
        let mut logs = String::new();
        let result = tokio::time::timeout(Duration::from_secs(30), async {
            tokio::try_join!(
                stdout.read_to_string(&mut progress),
                stderr.read_to_string(&mut logs),
                child.wait(),
            )
        })
        .await;
        if result.is_err() {
            let _ = child.kill().await;
        }
        let (_, _, status) = result.expect("worker output stalled").unwrap();
        assert_eq!(status.code(), Some(expected_exit));
        assert_eq!(
            progress
                .lines()
                .filter(|line| line.starts_with("progress:"))
                .collect::<Vec<_>>(),
            (0..LINE_COUNT)
                .map(|frame| format!("progress:{frame}"))
                .collect::<Vec<_>>()
        );
        assert_eq!(
            logs.lines().collect::<Vec<_>>(),
            (0..LINE_COUNT)
                .map(|frame| format!("log:{frame}:{}", "x".repeat(257)))
                .collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn drains_both_streams_beyond_pipe_capacity_and_reaches_eof() {
        for _ in 0..4 {
            check_output("success", 0).await;
        }
    }

    #[tokio::test]
    async fn preserves_output_when_worker_fails() {
        check_output("fail", 17).await;
    }

    #[tokio::test]
    async fn killing_worker_releases_pending_reads() {
        let mut child = spawn_with_piped_output(child_command("wait")).unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
        let mut stderr = child.stderr.take().unwrap();
        let result = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let line = stdout.next_line().await.unwrap().expect("worker exited");
                if line == "ready" {
                    break;
                }
            }
            let mut read = tokio::spawn(async move {
                let mut logs = String::new();
                stderr.read_to_string(&mut logs).await.unwrap();
                logs
            });
            assert!(
                tokio::time::timeout(Duration::from_millis(50), &mut read)
                    .await
                    .is_err()
            );
            child.kill().await.unwrap();
            while stdout.next_line().await.unwrap().is_some() {}
            assert!(read.await.unwrap().is_empty());
            assert!(!child.wait().await.unwrap().success());
        })
        .await;
        if result.is_err() {
            let _ = child.kill().await;
        }
        result.expect("worker cancellation stalled");
    }

    #[tokio::test]
    async fn reports_spawn_errors() {
        let directory = tempfile::tempdir().unwrap();
        let command = Command::new(directory.path().join("missing-worker"));
        assert!(spawn_with_piped_output(command).is_err());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_output_handles_are_synchronous() {
        use std::{ffi::c_void, os::windows::io::AsRawHandle};

        #[repr(C)]
        struct IoStatusBlock {
            status: usize,
            information: usize,
        }

        #[link(name = "ntdll")]
        unsafe extern "system" {
            fn NtQueryInformationFile(
                handle: *mut c_void,
                status: *mut IoStatusBlock,
                information: *mut c_void,
                length: u32,
                class: u32,
            ) -> i32;
        }

        fn is_synchronous(handle: &impl AsRawHandle) -> bool {
            const FILE_MODE_INFORMATION: u32 = 16;
            const FILE_SYNCHRONOUS_IO: u32 = 0x10 | 0x20;
            let mut status = IoStatusBlock {
                status: 0,
                information: 0,
            };
            let mut mode = 0u32;
            let result = unsafe {
                NtQueryInformationFile(
                    handle.as_raw_handle(),
                    &mut status,
                    (&mut mode as *mut u32).cast(),
                    size_of::<u32>() as u32,
                    FILE_MODE_INFORMATION,
                )
            };
            assert_eq!(result, 0);
            mode & FILE_SYNCHRONOUS_IO != 0
        }

        let mut legacy = child_command("wait")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let legacy_stdout = is_synchronous(legacy.stdout.as_ref().unwrap());
        legacy.kill().await.unwrap();
        assert!(!legacy_stdout, "negative control must use overlapped I/O");

        let mut child = spawn_with_piped_output(child_command("wait")).unwrap();
        let stdout = is_synchronous(child.stdout.as_ref().unwrap());
        let stderr = is_synchronous(child.stderr.as_ref().unwrap());
        child.kill().await.unwrap();
        assert!(stdout, "stdout must not use overlapped I/O");
        assert!(stderr, "stderr must not use overlapped I/O");
    }
}
