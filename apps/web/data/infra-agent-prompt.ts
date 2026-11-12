export const CAP_INFRA_POINTER_PROMPT =
	"Read https://cap.so/infra and set up Cap Infra for this project.";

const api = "/api/developer/v1";
const sdk = "/api/developer/sdk/v1/upload/multipart";

const calls = {
	createUpload: `POST ${api}/uploads`,
	renewToken: `POST ${api}/uploads/{id}/token`,
	initiate: `POST ${sdk}/initiate`,
	presignPart: `POST ${sdk}/presign-part`,
	complete: `POST ${sdk}/complete`,
	videoStatus: `GET ${api}/videos/{id}/status`,
	video: `GET ${api}/videos/{id}`,
	transcribeUrl: `POST ${api}/transcripts`,
	transcribeFile: `POST ${api}/transcripts/uploads`,
	startTranscript: `POST ${api}/transcripts/{id}/start`,
	transcript: `GET ${api}/transcripts/{id}`,
	usage: `GET ${api}/usage`,
} as const;

export const CAP_INFRA_AGENT_PROMPT = `Set up Cap Infra in this project so it can upload and play video.

Cap Infra is Cap's video and speech API. All you need is the app's secret key and the REST API. Read https://cap.so/openapi.json and https://cap.so/docs/api/rest-api first. Use only the methods and paths documented there, and take every field name from the OpenAPI document.

1. Find the secret key. I created the app in the Cap Infra console and put its secret key (csk_) in this project's local environment file as CAP_SECRET_KEY. Check that the variable is set without printing its value, and that the file is ignored by git. If it is missing, stop and ask me to add it to the file. Never ask me to paste the key into the chat, and never print, log or commit it.
2. Keep the key on the server. Send it only from server code, as Authorization: Bearer followed by the key. It never goes into browser code, a client bundle or a public environment variable.
3. Create uploads on the server. For a signed-in user, call ${calls.createUpload} and give the browser only what it returns for that one video: the upload token (cut_), the video id and the embed URL. In production, set corsOrigin to the site's origin.
4. Upload from the browser. With the upload token as the Bearer credential, call ${calls.initiate}, then ${calls.presignPart} with up to 50 part numbers in one request. PUT each part to its signed URL and keep the ETag it answers with, then call ${calls.complete}. If a call answers 401 with the code upload_token_expired, get a new token from the server with ${calls.renewToken} and continue with the same uploadId and ETags.
5. Wait until it plays. From the server, poll ${calls.videoStatus} no faster than once every 2 seconds. Stop when status is ready or errored, and show errorReason if it failed.
6. Play it. Show the video with its embedUrl, or build a player from hlsUrl and mp4Url in ${calls.video}. Use hlsUrl when it is present and mp4Url otherwise. shareUrl is the link to send to someone.
7. Transcribe when I ask. Transcripts are billed per audio hour, so confirm with me first. For a public URL call ${calls.transcribeUrl}. For a file call ${calls.transcribeFile}, PUT the file to the signed URL it returns, then call ${calls.startTranscript}. Poll ${calls.transcript} at the same pace until status is complete or error.
8. Stay inside the limit. A secret key allows 60 requests a minute across every endpoint. After a 429, wait for the number of seconds in the Retry-After header before you send the request again.
9. Watch the credits. ${calls.usage} shows the balance and whether uploads are allowed. A 402 means the app needs credit, so tell me and I will add it in the console.

Finish by uploading one short test video through the code you wrote. Ask me first, because stored video is billed daily. Then tell me what you changed and give me the video's shareUrl, and ask what I want to build next.`;
