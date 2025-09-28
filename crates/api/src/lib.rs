///! Types and implements for the Cap web API endpoints.

pub struct UploadMultipartInitiate {
    video_id: String,
}

// impl UploadMultipartInitiate {
//     pub fn as_request(self) -> reqwest::Request {
//         let mut request = reqwest::Request::new(
//             reqwest::Method::POST,
//             "https://api.example.com/upload_multipart_initiate"
//                 .parse()
//                 .unwrap(),
//         );
//         request.header("Authorization", "Bearer YOUR_TOKEN");
//         request.json(&self).unwrap();
//         request
//     }
// }

// #[derive(Default)]
// pub struct Api {
//     client: reqwest::Client,
//     bearer: Option<String>, // TODO: Hook this up
// }

// impl Api {
//     pub fn upload_multipart_initiate(&self) {
//         // self.client
//         todo!();
//     }
// }

// TODO: Helper for retries, exponential backoff
