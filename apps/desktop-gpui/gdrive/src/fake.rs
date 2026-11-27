use std::{
    collections::{BTreeMap, VecDeque},
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
};

use serde_json::{Value, json};

use crate::types::{CHUNK_ALIGN, Endpoints, FOLDER_MIME};

pub const FAKE_EMAIL: &str = "drive-user@example.com";
pub const FAKE_DISPLAY_NAME: &str = "Fake Drive User";
const FOLDER_QUERY: &str = "mimeType='application/vnd.google-apps.folder' and appProperties has { key='capFolder' and value='1' } and trashed=false";
const MAX_HEAD: usize = 64 * 1024;

#[derive(Clone, Debug)]
pub enum Fault {
    DropConnectionAfter { bytes: u64 },
    AcceptOnly { bytes: u64 },
    ChunkStatus { status: u16, reason: &'static str },
    StatusQueryGone,
    StatusQueryStatus { status: u16, reason: &'static str },
    InitStatus { status: u16, reason: &'static str },
    PermissionStatus { status: u16, reason: &'static str },
    ApiStatus { status: u16, reason: &'static str },
    TokenError { error: &'static str },
    Unauthorized,
}

#[derive(Clone, Debug)]
pub struct FakeFile {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub parents: Vec<String>,
    pub app_properties: BTreeMap<String, String>,
    pub bytes: Vec<u8>,
    pub trashed: bool,
    pub permissions: Vec<serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FakeRequest {
    pub method: String,
    pub target: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub body_len: usize,
}

impl FakeRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    pub fn path(&self) -> &str {
        self.target.split('?').next().unwrap_or_default()
    }

    pub fn query(&self, key: &str) -> Option<String> {
        let (_, query) = self.target.split_once('?')?;
        url::form_urlencoded::parse(query.as_bytes())
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.into_owned())
    }

    pub fn is_status_query(&self) -> bool {
        self.is_session_put()
            && self
                .header("content-range")
                .is_some_and(|range| range.starts_with("bytes */"))
    }

    pub fn is_chunk(&self) -> bool {
        self.is_session_put()
            && self
                .header("content-range")
                .is_some_and(|range| !range.starts_with("bytes */"))
    }

    fn is_session_put(&self) -> bool {
        self.method == "PUT" && self.path().starts_with("/upload/session/")
    }
}

pub fn web_view_link(file_id: &str) -> String {
    format!("https://drive.google.com/file/d/{file_id}/view?usp=drivesdk&resourcekey=0-fake")
}

struct UploadSession {
    total: u64,
    meta: Value,
    fields: Option<String>,
    bytes: Vec<u8>,
    file_id: Option<String>,
    gone: bool,
}

struct IssuedCode {
    code: String,
    refresh_token: String,
    scope: String,
    used: bool,
}

#[derive(Default)]
struct FakeState {
    faults: VecDeque<Fault>,
    codes: Vec<IssuedCode>,
    refresh_tokens: Vec<(String, String)>,
    refreshes: usize,
    access_tokens: usize,
    next_id: usize,
    files: Vec<FakeFile>,
    sessions: Vec<UploadSession>,
    sessions_started: usize,
    revoked: Vec<String>,
    requests: Vec<FakeRequest>,
}

struct Shared {
    base: String,
    state: Mutex<FakeState>,
    completed: tokio::sync::watch::Sender<usize>,
    stopped: AtomicBool,
}

impl Shared {
    fn state(&self) -> MutexGuard<'_, FakeState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

pub struct FakeGoogle {
    addr: SocketAddr,
    shared: Arc<Shared>,
}

impl FakeGoogle {
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind the fake Google server");
        let addr = listener.local_addr().expect("fake Google server address");
        let (completed, _) = tokio::sync::watch::channel(0);
        let shared = Arc::new(Shared {
            base: format!("http://{addr}"),
            state: Mutex::new(FakeState::default()),
            completed,
            stopped: AtomicBool::new(false),
        });
        let listening = shared.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if listening.stopped.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(stream) = stream else { continue };
                let shared = listening.clone();
                std::thread::spawn(move || serve(stream, &shared));
            }
        });
        Self { addr, shared }
    }

    pub fn base(&self) -> String {
        self.shared.base.clone()
    }

    pub fn endpoints(&self) -> Endpoints {
        Endpoints::local(&self.base())
    }

    pub fn push_fault(&self, fault: Fault) {
        self.shared.state().faults.push_back(fault);
    }

    pub fn faults_left(&self) -> usize {
        self.shared.state().faults.len()
    }

    pub fn issue_code(&self, code: &str, refresh_token: &str, scope: &str) {
        let mut state = self.shared.state();
        state.codes.push(IssuedCode {
            code: code.into(),
            refresh_token: refresh_token.into(),
            scope: scope.into(),
            used: false,
        });
        state
            .refresh_tokens
            .push((refresh_token.into(), scope.into()));
    }

    pub fn files(&self) -> Vec<FakeFile> {
        self.shared.state().files.clone()
    }

    pub fn sessions_started(&self) -> usize {
        self.shared.state().sessions_started
    }

    pub fn revoked(&self) -> Vec<String> {
        self.shared.state().revoked.clone()
    }

    pub fn requests(&self) -> Vec<FakeRequest> {
        self.shared.state().requests.clone()
    }

    pub fn trash(&self, file_id: &str) {
        for file in self
            .shared
            .state()
            .files
            .iter_mut()
            .filter(|f| f.id == file_id)
        {
            file.trashed = true;
        }
    }

    pub fn completed(&self) -> tokio::sync::watch::Receiver<usize> {
        self.shared.completed.subscribe()
    }
}

impl Drop for FakeGoogle {
    fn drop(&mut self) {
        self.shared.stopped.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.addr);
    }
}

enum Route {
    Token,
    Revoke,
    About,
    ListFiles,
    CreateFile,
    GetFile(String),
    Permissions(String),
    Init,
    SessionQuery(usize),
    SessionChunk(usize),
    Unknown,
}

fn route_of(request: &FakeRequest) -> Route {
    let segments: Vec<&str> = request.path().trim_start_matches('/').split('/').collect();
    match (request.method.as_str(), segments.as_slice()) {
        ("POST", ["token"]) => Route::Token,
        ("POST", ["revoke"]) => Route::Revoke,
        ("GET", ["drive", "v3", "about"]) => Route::About,
        ("GET", ["drive", "v3", "files"]) => Route::ListFiles,
        ("POST", ["drive", "v3", "files"]) => Route::CreateFile,
        ("GET", ["drive", "v3", "files", id]) => Route::GetFile((*id).to_string()),
        ("POST", ["drive", "v3", "files", id, "permissions"]) => {
            Route::Permissions((*id).to_string())
        }
        ("POST", ["upload", "drive", "v3", "files"]) => Route::Init,
        ("PUT", ["upload", "session", n]) => match n.parse() {
            Ok(n) if request.is_status_query() => Route::SessionQuery(n),
            Ok(n) => Route::SessionChunk(n),
            Err(_) => Route::Unknown,
        },
        _ => Route::Unknown,
    }
}

fn applies(fault: &Fault, route: &Route) -> bool {
    match fault {
        Fault::DropConnectionAfter { .. }
        | Fault::AcceptOnly { .. }
        | Fault::ChunkStatus { .. } => {
            matches!(route, Route::SessionChunk(_))
        }
        Fault::StatusQueryGone | Fault::StatusQueryStatus { .. } => {
            matches!(route, Route::SessionQuery(_))
        }
        Fault::InitStatus { .. } | Fault::Unauthorized => matches!(route, Route::Init),
        Fault::PermissionStatus { .. } => matches!(route, Route::Permissions(_)),
        Fault::ApiStatus { .. } => matches!(
            route,
            Route::About
                | Route::ListFiles
                | Route::CreateFile
                | Route::GetFile(_)
                | Route::Permissions(_)
        ),
        Fault::TokenError { .. } => matches!(route, Route::Token),
    }
}

struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

impl Reply {
    fn json(status: u16, body: Value) -> Self {
        Self {
            status,
            headers: vec![(
                "Content-Type".into(),
                "application/json; charset=UTF-8".into(),
            )],
            body: body.to_string(),
        }
    }

    fn empty(status: u16) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: String::new(),
        }
    }

    fn with_header(mut self, name: &str, value: String) -> Self {
        self.headers.push((name.into(), value));
        self
    }

    fn google_error(status: u16, reason: &str) -> Self {
        Self::json(
            status,
            json!({
                "error": {
                    "code": status,
                    "message": reason,
                    "errors": [{"domain": "global", "reason": reason, "message": reason}],
                    "status": status_name(status),
                }
            }),
        )
    }

    fn token_error(error: &str) -> Self {
        Self::json(
            400,
            json!({"error": error, "error_description": "refused by the fake Google server"}),
        )
    }
}

fn status_name(status: u16) -> &'static str {
    match status {
        400 => "INVALID_ARGUMENT",
        401 => "UNAUTHENTICATED",
        403 => "PERMISSION_DENIED",
        404 => "NOT_FOUND",
        429 => "RESOURCE_EXHAUSTED",
        500 => "INTERNAL",
        503 => "UNAVAILABLE",
        _ => "UNKNOWN",
    }
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        308 => "Resume Incomplete",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        410 => "Gone",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Unknown",
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn read_head(stream: &mut TcpStream) -> Option<(FakeRequest, Vec<u8>)> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let end = loop {
        if let Some(end) = find(&buf, b"\r\n\r\n") {
            break end;
        }
        if buf.len() > MAX_HEAD {
            return None;
        }
        let n = stream.read(&mut chunk).ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..end]).into_owned();
    let rest = buf[end + 4..].to_vec();
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next()?.split(' ');
    let method = request_line.next()?.to_string();
    let target = request_line.next()?.to_string();
    let headers = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
        .collect();
    Some((
        FakeRequest {
            method,
            target,
            headers,
            body: Vec::new(),
            body_len: 0,
        },
        rest,
    ))
}

fn read_body(stream: &mut TcpStream, mut body: Vec<u8>, len: usize) -> Vec<u8> {
    let mut chunk = [0u8; 64 * 1024];
    while body.len() < len {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => body.extend_from_slice(&chunk[..n]),
        }
    }
    body.truncate(len);
    body
}

fn write_reply(stream: &mut TcpStream, reply: &Reply) {
    let mut head = format!(
        "HTTP/1.1 {} {}\r\nContent-Length: {}\r\nConnection: close\r\n",
        reply.status,
        reason_phrase(reply.status),
        reply.body.len()
    );
    for (name, value) in &reply.headers {
        head.push_str(name);
        head.push_str(": ");
        head.push_str(value);
        head.push_str("\r\n");
    }
    head.push_str("\r\n");
    head.push_str(&reply.body);
    if stream.write_all(head.as_bytes()).is_ok() {
        let _ = stream.flush();
    }
}

fn serve(mut stream: TcpStream, shared: &Shared) {
    let Some((mut request, rest)) = read_head(&mut stream) else {
        return;
    };
    let route = route_of(&request);
    let wanted = request
        .header("content-length")
        .and_then(|len| len.parse().ok())
        .unwrap_or(0);
    let fault = {
        let mut state = shared.state();
        let position = state.faults.iter().position(|f| applies(f, &route));
        position.and_then(|i| state.faults.remove(i))
    };
    let session_route = matches!(route, Route::SessionChunk(_) | Route::SessionQuery(_));
    if let (Some(Fault::DropConnectionAfter { bytes }), Route::SessionChunk(n)) = (&fault, &route) {
        let limit = usize::try_from(*bytes).unwrap_or(usize::MAX).min(wanted);
        let body = read_body(&mut stream, rest, limit);
        let mut state = shared.state();
        state.keep(*n, &request, &body, usize::MAX);
        request.body_len = body.len();
        state.requests.push(request);
        return;
    }
    let body = read_body(&mut stream, rest, wanted);
    request.body_len = body.len();
    let (reply, completed) = {
        let mut state = shared.state();
        let answer = state.answer(&shared.base, &route, &request, &body, fault);
        if !session_route {
            request.body = body;
        }
        state.requests.push(request);
        answer
    };
    if completed {
        shared.completed.send_modify(|count| *count += 1);
    }
    write_reply(&mut stream, &reply);
}

fn has_bearer(request: &FakeRequest) -> bool {
    request
        .header("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|token| !token.is_empty())
}

fn text_list(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

fn text_map(value: &Value) -> BTreeMap<String, String> {
    value
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_string())))
        .collect()
}

fn file_json(file: &FakeFile, fields: Option<&str>) -> Value {
    let full = json!({
        "id": file.id,
        "name": file.name,
        "mimeType": file.mime_type,
        "parents": file.parents,
        "appProperties": file.app_properties,
        "webViewLink": web_view_link(&file.id),
        "trashed": file.trashed,
        "size": file.bytes.len().to_string(),
    });
    let wanted: Vec<&str> = fields.map_or(vec!["id", "name", "mimeType"], |fields| {
        fields.split(',').map(str::trim).collect()
    });
    let mut selected = serde_json::Map::new();
    for key in wanted {
        if let Some(value) = full.get(key) {
            selected.insert(key.to_string(), value.clone());
        }
    }
    Value::Object(selected)
}

fn parse_chunk_range(range: &str) -> Option<(u64, u64, u64)> {
    let (span, total) = range.strip_prefix("bytes ")?.split_once('/')?;
    let (first, last) = span.split_once('-')?;
    Some((first.parse().ok()?, last.parse().ok()?, total.parse().ok()?))
}

fn form(request: &FakeRequest, body: &[u8]) -> BTreeMap<String, String> {
    let query = request
        .target
        .split_once('?')
        .map(|(_, query)| query)
        .unwrap_or_default();
    url::form_urlencoded::parse(query.as_bytes())
        .chain(url::form_urlencoded::parse(body))
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect()
}

impl FakeState {
    fn new_id(&mut self, kind: &str) -> String {
        self.next_id += 1;
        format!("fake-{kind}-{}", self.next_id)
    }

    fn file(&self, id: &str) -> Option<&FakeFile> {
        self.files.iter().find(|file| file.id == id)
    }

    fn keep(&mut self, n: usize, request: &FakeRequest, body: &[u8], limit: usize) {
        let Some(session) = self.sessions.get_mut(n) else {
            return;
        };
        let Some((first, _, _)) = request.header("content-range").and_then(parse_chunk_range)
        else {
            return;
        };
        if session.gone || session.file_id.is_some() || first != session.bytes.len() as u64 {
            return;
        }
        let kept = body.len().min(limit);
        session.bytes.extend_from_slice(&body[..kept]);
    }

    fn answer(
        &mut self,
        base: &str,
        route: &Route,
        request: &FakeRequest,
        body: &[u8],
        fault: Option<Fault>,
    ) -> (Reply, bool) {
        match (fault, route) {
            (Some(Fault::TokenError { error }), _) => return (Reply::token_error(error), false),
            (
                Some(
                    Fault::ApiStatus { status, reason }
                    | Fault::PermissionStatus { status, reason }
                    | Fault::InitStatus { status, reason }
                    | Fault::ChunkStatus { status, reason }
                    | Fault::StatusQueryStatus { status, reason },
                ),
                _,
            ) => return (Reply::google_error(status, reason), false),
            (Some(Fault::Unauthorized), _) => {
                return (Reply::google_error(401, "authError"), false);
            }
            (Some(Fault::StatusQueryGone), Route::SessionQuery(n)) => {
                if let Some(session) = self.sessions.get_mut(*n) {
                    session.gone = true;
                }
                return (Reply::google_error(404, "notFound"), false);
            }
            (Some(Fault::AcceptOnly { bytes }), Route::SessionChunk(n)) => {
                let limit = usize::try_from(bytes).unwrap_or(usize::MAX);
                return self.chunk(*n, request, body, limit);
            }
            _ => {}
        }
        let needs_bearer = matches!(
            route,
            Route::About
                | Route::ListFiles
                | Route::CreateFile
                | Route::GetFile(_)
                | Route::Permissions(_)
                | Route::Init
        );
        if needs_bearer && !has_bearer(request) {
            return (Reply::google_error(401, "authError"), false);
        }
        let reply = match route {
            Route::Token => self.token(request, body),
            Route::Revoke => self.revoke(request, body),
            Route::About => Reply::json(
                200,
                json!({"user": {"emailAddress": FAKE_EMAIL, "displayName": FAKE_DISPLAY_NAME}}),
            ),
            Route::ListFiles => self.list(request),
            Route::CreateFile => self.create(request, body),
            Route::GetFile(id) => match self.file(id) {
                Some(file) => Reply::json(200, file_json(file, request.query("fields").as_deref())),
                None => Reply::google_error(404, "notFound"),
            },
            Route::Permissions(id) => self.permit(id, body),
            Route::Init => self.init(base, request, body),
            Route::SessionQuery(n) => return self.status(*n),
            Route::SessionChunk(n) => return self.chunk(*n, request, body, usize::MAX),
            Route::Unknown => Reply::google_error(404, "notFound"),
        };
        (reply, false)
    }

    fn token(&mut self, request: &FakeRequest, body: &[u8]) -> Reply {
        let form = form(request, body);
        let field = |name: &str| form.get(name).map(String::as_str).unwrap_or_default();
        if field("client_id").is_empty() {
            return Reply::token_error("invalid_client");
        }
        match field("grant_type") {
            "authorization_code" => {
                if field("code_verifier").is_empty()
                    || !field("redirect_uri").starts_with("http://127.0.0.1:")
                {
                    return Reply::token_error("invalid_request");
                }
                let code = field("code");
                let Some(issued) = self
                    .codes
                    .iter_mut()
                    .find(|issued| issued.code == code && !issued.used)
                else {
                    return Reply::token_error("invalid_grant");
                };
                issued.used = true;
                let (refresh_token, scope) = (issued.refresh_token.clone(), issued.scope.clone());
                let access_token = self.access_token();
                Reply::json(
                    200,
                    json!({
                        "access_token": access_token,
                        "expires_in": 3599,
                        "refresh_token": refresh_token,
                        "scope": scope,
                        "token_type": "Bearer",
                    }),
                )
            }
            "refresh_token" => {
                let presented = field("refresh_token");
                let Some(index) = self
                    .refresh_tokens
                    .iter()
                    .position(|(token, _)| token == presented)
                else {
                    return Reply::token_error("invalid_grant");
                };
                self.refreshes += 1;
                let access_token = self.access_token();
                let scope = self.refresh_tokens[index].1.clone();
                let mut answer = json!({
                    "access_token": access_token,
                    "expires_in": 3599,
                    "scope": scope,
                    "token_type": "Bearer",
                });
                if self.refreshes.is_multiple_of(2) {
                    let rotated = format!("fake-refresh-{}", self.refreshes);
                    self.refresh_tokens[index].0 = rotated.clone();
                    answer["refresh_token"] = Value::String(rotated);
                }
                Reply::json(200, answer)
            }
            _ => Reply::token_error("unsupported_grant_type"),
        }
    }

    fn access_token(&mut self) -> String {
        self.access_tokens += 1;
        format!("fake-access-{}", self.access_tokens)
    }

    fn revoke(&mut self, request: &FakeRequest, body: &[u8]) -> Reply {
        let Some(token) = form(request, body)
            .remove("token")
            .filter(|t| !t.is_empty())
        else {
            return Reply::token_error("invalid_request");
        };
        self.refresh_tokens.retain(|(live, _)| *live != token);
        self.revoked.push(token);
        Reply::json(200, json!({}))
    }

    fn list(&self, request: &FakeRequest) -> Reply {
        if request.query("q").as_deref() != Some(FOLDER_QUERY) {
            return Reply::google_error(400, "invalidQuery");
        }
        let files: Vec<Value> = self
            .files
            .iter()
            .filter(|file| {
                file.mime_type == FOLDER_MIME
                    && !file.trashed
                    && file.app_properties.get("capFolder").map(String::as_str) == Some("1")
            })
            .map(|file| json!({"id": file.id, "name": file.name}))
            .collect();
        Reply::json(200, json!({ "files": files }))
    }

    fn create(&mut self, request: &FakeRequest, body: &[u8]) -> Reply {
        let Ok(meta) = serde_json::from_slice::<Value>(body) else {
            return Reply::google_error(400, "parseError");
        };
        let id = self.new_id("folder");
        let file = FakeFile {
            id,
            name: meta["name"].as_str().unwrap_or_default().to_string(),
            mime_type: meta["mimeType"].as_str().unwrap_or_default().to_string(),
            parents: text_list(&meta["parents"]),
            app_properties: text_map(&meta["appProperties"]),
            bytes: Vec::new(),
            trashed: false,
            permissions: Vec::new(),
        };
        let reply = Reply::json(200, file_json(&file, request.query("fields").as_deref()));
        self.files.push(file);
        reply
    }

    fn permit(&mut self, id: &str, body: &[u8]) -> Reply {
        let Ok(permission) = serde_json::from_slice::<Value>(body) else {
            return Reply::google_error(400, "parseError");
        };
        let Some(file) = self.files.iter_mut().find(|file| file.id == id) else {
            return Reply::google_error(404, "notFound");
        };
        file.permissions.push(permission);
        Reply::json(
            200,
            json!({"id": "anyoneWithLink", "type": "anyone", "role": "reader"}),
        )
    }

    fn init(&mut self, base: &str, request: &FakeRequest, body: &[u8]) -> Reply {
        if request.query("uploadType").as_deref() != Some("resumable") {
            return Reply::google_error(400, "badRequest");
        }
        let Some(total) = request
            .header("x-upload-content-length")
            .and_then(|len| len.parse().ok())
        else {
            return Reply::google_error(400, "badRequest");
        };
        if request
            .header("x-upload-content-type")
            .is_none_or(str::is_empty)
        {
            return Reply::google_error(400, "badRequest");
        }
        let Ok(meta) = serde_json::from_slice::<Value>(body) else {
            return Reply::google_error(400, "parseError");
        };
        let parents_exist = text_list(&meta["parents"]).iter().all(|parent| {
            self.file(parent)
                .is_some_and(|folder| folder.mime_type == FOLDER_MIME && !folder.trashed)
        });
        if !parents_exist {
            return Reply::google_error(404, "notFound");
        }
        self.sessions.push(UploadSession {
            total,
            meta,
            fields: request.query("fields"),
            bytes: Vec::new(),
            file_id: None,
            gone: false,
        });
        self.sessions_started += 1;
        let n = self.sessions.len() - 1;
        Reply::empty(200).with_header("Location", format!("{base}/upload/session/{n}"))
    }

    fn status(&mut self, n: usize) -> (Reply, bool) {
        let Some(session) = self.sessions.get(n) else {
            return (Reply::google_error(404, "notFound"), false);
        };
        if session.gone {
            return (Reply::google_error(404, "notFound"), false);
        }
        if let Some(file) = session.file_id.as_deref().and_then(|id| self.file(id)) {
            return (
                Reply::json(200, file_json(file, session.fields.as_deref())),
                false,
            );
        }
        let received = session.bytes.len() as u64;
        if received == session.total {
            return (self.complete(n), true);
        }
        (resume_incomplete(received), false)
    }

    fn chunk(
        &mut self,
        n: usize,
        request: &FakeRequest,
        body: &[u8],
        limit: usize,
    ) -> (Reply, bool) {
        let Some(session) = self.sessions.get(n) else {
            return (Reply::google_error(404, "notFound"), false);
        };
        if session.gone {
            return (Reply::google_error(404, "notFound"), false);
        }
        let received = session.bytes.len() as u64;
        let valid = request
            .header("content-range")
            .and_then(parse_chunk_range)
            .is_some_and(|(first, last, total)| {
                let len = last + 1 - first.min(last + 1);
                total == session.total
                    && first == received
                    && last < total
                    && len == body.len() as u64
                    && (last + 1 == total || len.is_multiple_of(CHUNK_ALIGN as u64))
            });
        if !valid {
            return (Reply::google_error(400, "badContentRange"), false);
        }
        self.keep(n, request, body, limit);
        let session = &self.sessions[n];
        let received = session.bytes.len() as u64;
        if received == session.total {
            return (self.complete(n), true);
        }
        (resume_incomplete(received), false)
    }

    fn complete(&mut self, n: usize) -> Reply {
        let id = self.new_id("file");
        let session = &mut self.sessions[n];
        session.file_id = Some(id.clone());
        let file = FakeFile {
            id,
            name: session.meta["name"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            mime_type: session.meta["mimeType"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            parents: text_list(&session.meta["parents"]),
            app_properties: text_map(&session.meta["appProperties"]),
            bytes: std::mem::take(&mut session.bytes),
            trashed: false,
            permissions: Vec::new(),
        };
        let reply = Reply::json(200, file_json(&file, session.fields.as_deref()));
        self.files.push(file);
        reply
    }
}

fn resume_incomplete(received: u64) -> Reply {
    let reply = Reply::empty(308);
    if received == 0 {
        reply
    } else {
        reply.with_header("Range", format!("bytes=0-{}", received - 1))
    }
}
