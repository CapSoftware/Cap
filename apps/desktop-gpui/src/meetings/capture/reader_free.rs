//! Linux (PipeWire): while a screen reader's speech stream exists, the
//! meeting reads a capture stream of its own (an input node, never an output
//! anyone can pick, gone with Cap) that every stream playing to the read
//! output is linked into, except the reader's speech (speech-dispatcher,
//! which keeps a stream open for as long as it runs and opens one more per
//! message). Nothing here runs otherwise. On PulseAudio alone the reader's
//! speech stays in computer audio.

/// The node name of Cap's own capture while a reader speaks.
pub const NODE: &str = "cap-meeting-reader-free";

/// A screen reader's speech: everything speech-dispatcher plays.
pub fn is_reader_stream(app: &str) -> bool {
    app.starts_with("speech-dispatcher")
}

/// Whether a screen reader runs (Orca, by process name). speech-dispatcher
/// alone is not one: a browser reading a page aloud starts it too, and that
/// speech stays in the meeting as before.
#[cfg(target_os = "linux")]
pub fn screen_reader_running() -> bool {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return false;
    };
    entries.flatten().any(|entry| {
        entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.bytes().all(|b| b.is_ascii_digit()))
            && std::fs::read_to_string(entry.path().join("comm"))
                .is_ok_and(|comm| comm.trim_end() == "orca")
    })
}

/// Whether `LC_ALL=C pactl info` describes PipeWire's Pulse server.
pub fn on_pipewire(info: &str) -> bool {
    info.lines().any(|line| {
        line.trim()
            .strip_prefix("Server Name:")
            .is_some_and(|name| name.contains("PipeWire"))
    })
}

/// From `pw-dump`: the links (output port, input port) still missing for
/// every stream that plays to `output`, except a reader's, to also reach
/// `ours` (a node by name): channel by channel, or every channel into a
/// single input.
pub fn plan_links(dump: &serde_json::Value, output: &str, ours: &str) -> Vec<(u64, u64)> {
    let Some(objects) = dump.as_array() else {
        return Vec::new();
    };
    let kind = |o: &serde_json::Value| {
        o.get("type")
            .and_then(|t| t.as_str())
            .and_then(|t| t.rsplit(':').next())
            .unwrap_or("")
            .to_string()
    };
    let props = |o: &serde_json::Value| o.get("info").and_then(|i| i.get("props")).cloned();
    let prop = |o: &serde_json::Value, key: &str| {
        props(o)
            .and_then(|p| p.get(key).cloned())
            .and_then(|v| match v {
                serde_json::Value::String(s) => Some(s),
                serde_json::Value::Number(n) => Some(n.to_string()),
                serde_json::Value::Bool(b) => Some(b.to_string()),
                _ => None,
            })
            .unwrap_or_default()
    };
    let id = |o: &serde_json::Value| o.get("id").and_then(|i| i.as_u64());
    let sink = |name: &str| {
        objects
            .iter()
            .find(|o| {
                kind(o) == "Node"
                    && prop(o, "media.class") == "Audio/Sink"
                    && prop(o, "node.name") == name
            })
            .and_then(id)
    };
    let node = |name: &str| {
        objects
            .iter()
            .find(|o| kind(o) == "Node" && prop(o, "node.name") == name)
            .and_then(id)
    };
    let (Some(output), Some(ours)) = (sink(output), node(ours)) else {
        return Vec::new();
    };
    let info_u64 = |o: &serde_json::Value, key: &str| {
        o.get("info")
            .and_then(|i| i.get(key))
            .and_then(|v| v.as_u64())
    };
    let links: Vec<(u64, u64, u64, u64)> = objects
        .iter()
        .filter(|o| kind(o) == "Link")
        .filter_map(|o| {
            Some((
                info_u64(o, "output-node-id")?,
                info_u64(o, "input-node-id")?,
                info_u64(o, "output-port-id")?,
                info_u64(o, "input-port-id")?,
            ))
        })
        .collect();
    // Ports: (id, node, direction, channel), monitor ports left out.
    let ports: Vec<(u64, u64, String, String)> = objects
        .iter()
        .filter(|o| kind(o) == "Port" && prop(o, "port.monitor") != "true")
        .filter_map(|o| {
            let node = prop(o, "node.id").parse().ok()?;
            let direction = o
                .get("info")
                .and_then(|i| i.get("direction"))
                .and_then(|d| d.as_str())
                .unwrap_or("")
                .to_string();
            Some((id(o)?, node, direction, prop(o, "audio.channel")))
        })
        .collect();
    let our_inputs: Vec<&(u64, u64, String, String)> = ports
        .iter()
        .filter(|(_, node, direction, _)| *node == ours && direction == "input")
        .collect();
    let mut plan = Vec::new();
    for stream in objects.iter().filter(|o| {
        kind(o) == "Node"
            && prop(o, "media.class") == "Stream/Output/Audio"
            && !is_reader_stream(&prop(o, "application.name"))
            && !is_reader_stream(&prop(o, "node.name"))
    }) {
        let Some(stream) = id(stream) else { continue };
        if !links
            .iter()
            .any(|(from, to, _, _)| *from == stream && *to == output)
        {
            continue;
        }
        for (port, _, _, channel) in ports
            .iter()
            .filter(|(_, node, direction, _)| *node == stream && direction == "output")
        {
            for (input, _, _, ours_channel) in our_inputs.iter() {
                let wanted = our_inputs.len() == 1
                    || channel == ours_channel
                    || channel == "MONO"
                    || channel.is_empty();
                let present = links
                    .iter()
                    .any(|(_, _, from, to)| from == port && to == input);
                if wanted && !present {
                    plan.push((*port, *input));
                }
            }
        }
    }
    plan
}

/// From `pw-dump`: our links (by id) from streams that no longer play to
/// `output`, so after a follow only what plays there reaches `ours`, as a
/// monitor read of `output` would.
pub fn plan_unlinks(dump: &serde_json::Value, output: &str, ours: &str) -> Vec<u64> {
    let Some(objects) = dump.as_array() else {
        return Vec::new();
    };
    let is = |o: &serde_json::Value, kind: &str| {
        o.get("type")
            .and_then(|t| t.as_str())
            .and_then(|t| t.rsplit(':').next())
            == Some(kind)
    };
    let prop = |o: &serde_json::Value, key: &str| {
        o.get("info")
            .and_then(|i| i.get("props"))
            .and_then(|p| p.get(key))
            .and_then(|v| v.as_str())
            .map(str::to_string)
    };
    let node = |name: &str, class: Option<&str>| {
        objects
            .iter()
            .find(|o| {
                is(o, "Node")
                    && prop(o, "node.name").as_deref() == Some(name)
                    && class.is_none_or(|c| prop(o, "media.class").as_deref() == Some(c))
            })
            .and_then(|o| o.get("id").and_then(|i| i.as_u64()))
    };
    let (Some(output), Some(ours)) = (node(output, Some("Audio/Sink")), node(ours, None)) else {
        return Vec::new();
    };
    let ends = |o: &serde_json::Value| {
        let info = o.get("info")?;
        Some((
            o.get("id")?.as_u64()?,
            info.get("output-node-id")?.as_u64()?,
            info.get("input-node-id")?.as_u64()?,
        ))
    };
    let links: Vec<(u64, u64, u64)> = objects
        .iter()
        .filter(|o| is(o, "Link"))
        .filter_map(ends)
        .collect();
    links
        .iter()
        .filter(|(_, from, to)| {
            *to == ours
                && !links
                    .iter()
                    .any(|(_, other, sink)| other == from && *sink == output)
        })
        .map(|(id, _, _)| *id)
        .collect()
}

#[cfg(target_os = "linux")]
pub use platform::ReaderFree;

#[cfg(target_os = "linux")]
mod platform {
    use std::{
        io::{BufRead, BufReader},
        process::{Child, Command, Stdio},
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, Ordering},
        },
        thread::JoinHandle,
        time::{Duration, Instant},
    };

    use pipewire as pw;
    use pw::{properties::properties, spa};

    use super::{NODE, plan_links, plan_unlinks};

    /// 20 ms at the monitor's rate.
    const CHUNK: usize = super::super::MONITOR_RATE as usize / 50;

    /// Test builds only: `CAP_GPUI_TEST_READER_EXCLUDE_FAIL` makes the
    /// reader-free capture fail to start, to prove the fallback.
    fn refused_for_test() -> bool {
        cfg!(debug_assertions) && std::env::var_os("CAP_GPUI_TEST_READER_EXCLUDE_FAIL").is_some()
    }

    fn run(program: &str, args: &[&str]) -> Result<String, String> {
        let out = Command::new(program)
            .args(args)
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map_err(|e| format!("{program}: {e}"))?;
        if !out.status.success() {
            return Err(format!("{program} {} failed", args.first().unwrap_or(&"")));
        }
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// The graph. Older pw-dump (0.3.65) can print a second document when
    /// the graph changes while it dumps; the first is the whole graph.
    fn dump() -> Result<serde_json::Value, String> {
        let text = run("pw-dump", &[])?;
        match serde_json::Deserializer::from_str(&text)
            .into_iter::<serde_json::Value>()
            .next()
        {
            Some(Ok(graph)) => Ok(graph),
            Some(Err(error)) => Err(error.to_string()),
            None => Err("pw-dump printed nothing".into()),
        }
    }

    fn node_present(dump: &serde_json::Value) -> bool {
        dump.as_array().is_some_and(|objects| {
            objects.iter().any(|o| {
                o.get("info")
                    .and_then(|i| i.get("props"))
                    .and_then(|p| p.get("node.name"))
                    .and_then(|n| n.as_str())
                    == Some(NODE)
            })
        })
    }

    /// Links every non-reader stream that plays to `output` into our capture
    /// too. The number of links made.
    fn link(output: &str) -> Result<usize, String> {
        let plan = plan_links(&dump()?, output, NODE);
        for (from, to) in &plan {
            run("pw-link", &[&from.to_string(), &to.to_string()])?;
        }
        Ok(plan.len())
    }

    /// Links what plays to `output` into our capture and removes our links
    /// from streams that play elsewhere now, from one look at the graph.
    fn reconcile(output: &str) -> Result<(), String> {
        let graph = dump()?;
        let links = plan_links(&graph, output, NODE);
        let unlinks = plan_unlinks(&graph, output, NODE);
        tracing::debug!(
            output,
            links = links.len(),
            unlinks = unlinks.len(),
            "reader-free links reconciled"
        );
        for (from, to) in links {
            run("pw-link", &[&from.to_string(), &to.to_string()])?;
        }
        for id in unlinks {
            run("pw-link", &["-d", &id.to_string()])?;
        }
        Ok(())
    }

    /// Cap's own capture stream: an input node no one plays to on their own
    /// (not autoconnected, not an output anyone can pick), kept running with
    /// nothing linked so it always delivers. It goes with this process.
    struct Capture {
        stop: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
    }

    impl Capture {
        fn start(mut sink: impl FnMut(&[f32]) + Send + 'static) -> Result<Self, String> {
            let stop = Arc::new(AtomicBool::new(false));
            let (ready_tx, ready_rx) = flume::bounded::<Result<(), String>>(1);
            let thread = std::thread::Builder::new()
                .name("cap-meeting-reader-free".into())
                .spawn({
                    let stop = stop.clone();
                    move || {
                        // Everything lives in this scope: the core borrows the
                        // context, the stream the core.
                        macro_rules! or_fail {
                            ($e:expr) => {
                                match $e {
                                    Ok(value) => value,
                                    Err(error) => {
                                        let _ = ready_tx.send(Err(error.to_string()));
                                        return;
                                    }
                                }
                            };
                        }
                        pw::init();
                        let thread_loop = or_fail!(unsafe {
                            pw::thread_loop::ThreadLoopBox::new(Some("cap-reader-free"), None)
                        });
                        let context =
                            or_fail!(pw::context::ContextBox::new(thread_loop.loop_(), None));
                        let core = or_fail!(context.connect(None));
                        let stream = or_fail!(pw::stream::StreamBox::new(
                            &core,
                            "Cap meeting audio",
                            properties! {
                                *pw::keys::MEDIA_TYPE => "Audio",
                                *pw::keys::MEDIA_CATEGORY => "Capture",
                                *pw::keys::NODE_NAME => NODE,
                                *pw::keys::NODE_DESCRIPTION => "Cap meeting audio without the screen reader",
                                "node.autoconnect" => "false",
                                "node.always-process" => "true",
                                "node.want-driver" => "true",
                                // 20 ms, as the monitor reader reads.
                                "node.latency" => "960/48000",
                            },
                        ));
                        let listener = or_fail!(
                            stream
                                .add_local_listener_with_user_data(Vec::<f32>::with_capacity(
                                    CHUNK * 4,
                                ))
                                .process(move |stream, pending: &mut Vec<f32>| {
                                    let Some(mut buffer) = stream.dequeue_buffer() else {
                                        return;
                                    };
                                    let datas = buffer.datas_mut();
                                    let Some(data) = datas.first_mut() else { return };
                                    let size = data.chunk().size() as usize;
                                    if let Some(bytes) = data.data() {
                                        pending.extend(
                                            bytes[..size.min(bytes.len())]
                                                .chunks_exact(4)
                                                .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])),
                                        );
                                        // Steady 20 ms chunks, as the monitor
                                        // reader delivers.
                                        while pending.len() >= CHUNK {
                                            sink(&pending[..CHUNK]);
                                            pending.drain(..CHUNK);
                                        }
                                    }
                                })
                                .register()
                        );
                        let mut info = spa::param::audio::AudioInfoRaw::new();
                        info.set_format(spa::param::audio::AudioFormat::F32LE);
                        info.set_rate(super::super::MONITOR_RATE);
                        info.set_channels(1);
                        let bytes = or_fail!(
                            spa::pod::serialize::PodSerializer::serialize(
                                std::io::Cursor::new(Vec::new()),
                                &spa::pod::Value::Object(spa::pod::Object {
                                    type_: spa::utils::SpaTypes::ObjectParamFormat.as_raw(),
                                    id: spa::param::ParamType::EnumFormat.as_raw(),
                                    properties: info.into(),
                                }),
                            )
                            .map_err(|e| format!("{e:?}"))
                        )
                        .0
                        .into_inner();
                        let pod = or_fail!(
                            spa::pod::Pod::from_bytes(&bytes).ok_or("the capture format did not build")
                        );
                        let mut params = [pod];
                        or_fail!(stream.connect(
                            spa::utils::Direction::Input,
                            None,
                            pw::stream::StreamFlags::MAP_BUFFERS | pw::stream::StreamFlags::RT_PROCESS,
                            &mut params,
                        ));
                        thread_loop.start();
                        let _ = ready_tx.send(Ok(()));
                        let poll = Duration::from_millis(50);
                        loop {
                            if stop.load(Ordering::Acquire) {
                                break;
                            }
                            std::thread::park_timeout(poll);
                        }
                        thread_loop.stop();
                        drop(listener);
                        drop(stream);
                        drop(core);
                        drop(context);
                        drop(thread_loop);
                    }
                })
                .map_err(|e| e.to_string())?;
            match ready_rx.recv_timeout(Duration::from_secs(3)) {
                Ok(Ok(())) => Ok(Self {
                    stop,
                    thread: Some(thread),
                }),
                Ok(Err(error)) => {
                    let _ = thread.join();
                    Err(error)
                }
                Err(_) => {
                    stop.store(true, Ordering::Release);
                    Err("the reader-free capture did not start in time".into())
                }
            }
        }
    }

    impl Drop for Capture {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    /// Our capture, kept linked while it lives: a new stream is linked as
    /// soon as the sound server says it appeared. Silent until [`go_live`].
    ///
    /// [`go_live`]: ReaderFree::go_live
    pub struct ReaderFree {
        capture: Option<Capture>,
        live: Arc<AtomicBool>,
        output: Arc<Mutex<String>>,
        events: Option<Child>,
        thread: Option<JoinHandle<()>>,
        reconciler: Option<JoinHandle<()>>,
    }

    impl ReaderFree {
        /// Starts our capture and links what plays to `output` (the output
        /// the meeting reads now) into it. Samples reach `sink` only once
        /// live. Everything is undone on failure.
        pub fn start(
            output: &str,
            mut sink: impl FnMut(&[f32]) + Send + 'static,
        ) -> Result<Self, String> {
            if refused_for_test() {
                return Err("refused for the test".into());
            }
            let live = Arc::new(AtomicBool::new(false));
            let gate = live.clone();
            let capture = Capture::start(move |samples| {
                if gate.load(Ordering::Acquire) {
                    sink(samples);
                }
            })?;
            let mut made = Self {
                capture: Some(capture),
                live,
                output: Arc::new(Mutex::new(output.to_string())),
                events: None,
                thread: None,
                reconciler: None,
            };
            // Our node appears in the graph a moment after it connects.
            let waited = Instant::now();
            loop {
                if dump().is_ok_and(|d| node_present(&d)) {
                    break;
                }
                if waited.elapsed() > Duration::from_secs(2) {
                    return Err("the reader-free capture never appeared".into());
                }
                std::thread::sleep(Duration::from_millis(30));
            }
            link(output)?;
            let mut events = Command::new("pactl")
                .arg("subscribe")
                .env("LC_ALL", "C")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| e.to_string())?;
            let stdout = events.stdout.take();
            made.events = Some(events);
            let current = made.output.clone();
            // A stream that appears or changes (moved to another output, or
            // only its volume) wakes one look at the graph; a burst of
            // changes is one look.
            let (wake, woken) = flume::bounded::<()>(1);
            made.reconciler = std::thread::Builder::new()
                .name("cap-meeting-reader-free-reconcile".into())
                .spawn(move || {
                    while woken.recv().is_ok() {
                        // A new or moved stream reaches its output a moment
                        // after the event.
                        std::thread::sleep(Duration::from_millis(30));
                        while woken.try_recv().is_ok() {}
                        let output = current.lock().map(|o| o.clone()).unwrap_or_default();
                        if let Err(error) = reconcile(&output) {
                            tracing::debug!(%error, "could not update the reader-free capture's links");
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                })
                .ok();
            made.thread = stdout.and_then(|stdout| {
                std::thread::Builder::new()
                    .name("cap-meeting-reader-free-links".into())
                    .spawn(move || {
                        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                            // A stream moved to another output can show only as
                            // a change on the outputs, not on the stream.
                            if line.contains("'new' on sink-input")
                                || line.contains("'change' on sink-input")
                                || line.contains("'change' on sink #")
                            {
                                let _ = wake.try_send(());
                            }
                        }
                    })
                    .ok()
            });
            Ok(made)
        }

        /// From now on its samples reach the meeting.
        pub fn go_live(&self) {
            self.live.store(true, Ordering::Release);
        }

        /// The output the meeting would read without a reader changed (a
        /// call followed to a headset): link what plays there.
        pub fn follow(&self, output: &str) {
            let changed = self
                .output
                .lock()
                .map(|mut current| {
                    let changed = *current != output;
                    *current = output.to_string();
                    changed
                })
                .unwrap_or(false);
            if !changed {
                return;
            }
            if let Err(error) = reconcile(output) {
                tracing::debug!(%error, "could not follow the new output with the reader-free capture");
            }
        }
    }

    impl Drop for ReaderFree {
        fn drop(&mut self) {
            self.live.store(false, Ordering::Release);
            if let Some(mut events) = self.events.take() {
                let _ = events.kill();
                let _ = events.wait();
            }
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
            // The events thread is gone, so the reconciler's channel closes.
            if let Some(reconciler) = self.reconciler.take() {
                let _ = reconciler.join();
            }
            // Our node, and every link into it, goes with the capture.
            drop(self.capture.take());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node(id: u64, class: &str, name: &str, app: &str) -> serde_json::Value {
        json!({"id": id, "type": "PipeWire:Interface:Node", "info": {"props": {
            "media.class": class, "node.name": name, "application.name": app}}})
    }
    fn port(id: u64, node: u64, direction: &str, channel: &str) -> serde_json::Value {
        json!({"id": id, "type": "PipeWire:Interface:Port", "info": {"direction": direction,
            "props": {"node.id": node, "audio.channel": channel}}})
    }
    fn link(out_node: u64, in_node: u64, out_port: u64, in_port: u64) -> serde_json::Value {
        json!({"id": 1000 + out_port, "type": "PipeWire:Interface:Link", "info": {
            "output-node-id": out_node, "input-node-id": in_node,
            "output-port-id": out_port, "input-port-id": in_port}})
    }

    /// The probe's graph (Ubuntu 24.04, PipeWire 1.0.5) plus a call stream
    /// and our sink.
    fn graph() -> serde_json::Value {
        json!([
            node(45, "Audio/Sink", "room", ""),
            port(43, 45, "input", "FL"),
            port(42, 45, "input", "FR"),
            node(60, "Stream/Input/Audio", NODE, "Cap"),
            port(61, 60, "input", "MONO"),
            node(
                39,
                "Stream/Output/Audio",
                "speech-dispatcher-dummy",
                "speech-dispatcher-dummy"
            ),
            port(46, 39, "output", "FL"),
            port(47, 39, "output", "FR"),
            link(39, 45, 46, 43),
            link(39, 45, 47, 42),
            node(
                51,
                "Stream/Output/Audio",
                "speech-dispatcher",
                "speech-dispatcher"
            ),
            port(53, 51, "output", "FL"),
            link(51, 45, 53, 43),
            node(70, "Stream/Output/Audio", "Chromium", "Chromium"),
            port(71, 70, "output", "FL"),
            port(72, 70, "output", "FR"),
            link(70, 45, 71, 43),
            link(70, 45, 72, 42),
            node(80, "Stream/Output/Audio", "paplay", "paplay"),
            port(81, 80, "output", "MONO"),
            link(80, 45, 81, 43),
            node(90, "Stream/Output/Audio", "music", "music"),
            port(91, 90, "output", "FL"),
        ])
    }

    #[test]
    fn everything_but_the_readers_speech_reaches_our_capture() {
        let plan = plan_links(&graph(), "room", NODE);
        // The call (both channels) and the mono stream into our one input;
        // never speech-dispatcher, never a stream that plays elsewhere.
        assert_eq!(plan, vec![(71, 61), (72, 61), (81, 61)]);
    }

    #[test]
    fn links_already_made_are_not_made_again() {
        let mut g = graph();
        g.as_array_mut().unwrap().push(link(70, 60, 71, 61));
        assert_eq!(plan_links(&g, "room", NODE), vec![(72, 61), (81, 61)]);
    }

    #[test]
    fn a_follow_unlinks_only_streams_that_left_the_output() {
        // The call (70) moved from the room to the headset; paplay (80)
        // stays in the room. Both were linked into our capture while the
        // room was read.
        let with_id = |id: u64, mut link: serde_json::Value| {
            link["id"] = json!(id);
            link
        };
        let mut g = graph();
        let objects = g.as_array_mut().unwrap();
        objects.retain(|o| o["id"] != json!(1071) && o["id"] != json!(1072));
        objects.extend([
            node(100, "Audio/Sink", "headset", ""),
            with_id(2001, link(70, 100, 71, 101)),
            with_id(2002, link(70, 100, 72, 102)),
            with_id(3071, link(70, 60, 71, 61)),
            with_id(3072, link(70, 60, 72, 61)),
            with_id(3081, link(80, 60, 81, 61)),
        ]);
        assert_eq!(plan_unlinks(&g, "headset", NODE), vec![3081]);
        assert_eq!(plan_unlinks(&g, "room", NODE), vec![3071, 3072]);
        assert!(plan_unlinks(&g, "missing", NODE).is_empty());
        assert!(plan_unlinks(&json!([]), "room", NODE).is_empty());
    }

    #[test]
    fn nothing_without_the_output_and_our_capture() {
        assert!(plan_links(&graph(), "headset", NODE).is_empty());
        assert!(plan_links(&json!([]), "room", NODE).is_empty());
    }

    #[test]
    fn readers_and_servers_are_recognised() {
        assert!(is_reader_stream("speech-dispatcher"));
        assert!(is_reader_stream("speech-dispatcher-espeak-ng"));
        assert!(!is_reader_stream("Chromium"));
        assert!(on_pipewire(
            "Server String: x\nServer Name: PulseAudio (on PipeWire 1.0.5)\n"
        ));
        assert!(!on_pipewire("Server Name: pulseaudio\n"));
    }
}
