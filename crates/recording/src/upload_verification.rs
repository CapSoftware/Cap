use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UploadArtifact {
    Segments {
        #[serde(rename = "manifestSha256")]
        manifest_sha256: String,
    },
    Mp4 {
        #[serde(rename = "fileSize")]
        file_size: u64,
        duration: f64,
        #[serde(default, rename = "objectIdentity")]
        object_identity: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadVerification {
    pub version: u32,
    pub artifact: UploadArtifact,
    pub required_audio: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedUploadReceipt {
    pub version: u32,
    pub video_id: String,
    pub artifact: UploadArtifact,
    pub file_size: u64,
    pub duration: f64,
    pub has_audio: bool,
    pub full_decode: bool,
    #[serde(default)]
    pub required_audio_verified: bool,
}

impl UploadVerification {
    pub fn segments(manifest_json: &[u8], required_audio: bool) -> Self {
        Self {
            version: 1,
            artifact: UploadArtifact::Segments {
                manifest_sha256: hex::encode(Sha256::digest(manifest_json)),
            },
            required_audio,
        }
    }

    pub fn mp4(
        file_size: u64,
        duration: f64,
        required_audio: bool,
        object_identity: String,
    ) -> Result<Self, String> {
        if file_size == 0
            || !duration.is_finite()
            || duration <= 0.0
            || !valid_object_identity(&object_identity)
        {
            return Err("Cannot verify an empty or invalid recording".into());
        }
        Ok(Self {
            version: 1,
            artifact: UploadArtifact::Mp4 {
                file_size,
                duration,
                object_identity,
            },
            required_audio,
        })
    }

    pub fn requires_reupload(&self) -> bool {
        matches!(&self.artifact, UploadArtifact::Mp4 { object_identity, .. } if !valid_object_identity(object_identity))
    }

    pub fn verified_receipt(
        &self,
        video_id: &str,
        response: &serde_json::Value,
    ) -> Result<Option<VerifiedUploadReceipt>, String> {
        if response.get("status").and_then(serde_json::Value::as_str) != Some("verified") {
            return Ok(None);
        }
        if response.get("success").and_then(serde_json::Value::as_bool) != Some(true) {
            return Err("Server did not confirm recording verification".into());
        }
        let receipt: VerifiedUploadReceipt = serde_json::from_value(
            response
                .get("verification")
                .cloned()
                .ok_or("Server omitted the recording verification receipt")?,
        )
        .map_err(|error| format!("Invalid recording verification receipt: {error}"))?;
        if self.version != 1
            || self.requires_reupload()
            || receipt.version != self.version
            || receipt.video_id != video_id
            || receipt.artifact != self.artifact
            || receipt.file_size == 0
            || !receipt.duration.is_finite()
            || receipt.duration <= 0.0
            || !receipt.full_decode
            || (self.required_audio && (!receipt.has_audio || !receipt.required_audio_verified))
        {
            return Err("Recording verification did not match the local recording".into());
        }
        if let UploadArtifact::Mp4 {
            file_size,
            duration,
            ..
        } = self.artifact
            && (receipt.file_size != file_size
                || (receipt.duration - duration).abs() > duration_tolerance(duration))
        {
            return Err("Uploaded recording size or duration did not match".into());
        }
        Ok(Some(receipt))
    }
}

fn valid_object_identity(value: &str) -> bool {
    value.len() >= 3
        && value.len() <= 1024
        && value.starts_with('"')
        && value.ends_with('"')
        && value[1..value.len() - 1]
            .bytes()
            .all(|byte| byte.is_ascii_graphic() && byte != b'"' && byte != b'\\')
}

pub fn completed_drive_object_identity(
    value: &serde_json::Value,
    expected_size: u64,
) -> Option<String> {
    let id = value.get("id")?.as_str()?;
    let version = value.get("version")?.as_str()?;
    let size = value.get("size")?.as_str()?.parse::<u64>().ok()?;
    if id.is_empty()
        || version.is_empty()
        || !version.bytes().all(|byte| byte.is_ascii_digit())
        || size != expected_size
        || size == 0
    {
        return None;
    }
    let identity = format!("\"{id}:{version}\"");
    valid_object_identity(&identity).then_some(identity)
}

fn duration_tolerance(duration: f64) -> f64 {
    (duration * 0.01).clamp(0.5, 5.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn response(request: &UploadVerification) -> serde_json::Value {
        json!({
            "success": true,
            "status": "verified",
            "verification": {
                "version": 1,
                "videoId": "owned-video",
                "artifact": request.artifact,
                "fileSize": 4096,
                "duration": 10.0,
                "hasAudio": true,
                "fullDecode": true,
                "requiredAudioVerified": request.required_audio,
            }
        })
    }

    #[test]
    fn queue_acceptance_never_authorizes_local_deletion() {
        let request = UploadVerification::segments(b"final manifest", true);
        for status in [
            "queued",
            "already-processing",
            "already-complete",
            "complete",
        ] {
            assert!(
                request
                    .verified_receipt("owned-video", &json!({"success": true, "status": status}))
                    .unwrap()
                    .is_none()
            );
        }
    }

    #[test]
    fn receipt_must_match_identity_audio_and_generation() {
        let request = UploadVerification::segments(b"final manifest", true);
        assert!(
            request
                .verified_receipt("owned-video", &response(&request))
                .unwrap()
                .is_some()
        );
        for (field, value) in [
            ("videoId", json!("other-video")),
            ("version", json!(2)),
            ("hasAudio", json!(false)),
            ("fullDecode", json!(false)),
            ("requiredAudioVerified", json!(false)),
            ("fileSize", json!(0)),
            ("duration", json!(0)),
            (
                "artifact",
                json!({"kind":"segments","manifestSha256":"stale"}),
            ),
        ] {
            let mut invalid = response(&request);
            invalid["verification"][field] = value;
            assert!(request.verified_receipt("owned-video", &invalid).is_err());
        }
    }

    #[test]
    fn mp4_receipt_must_match_final_file_size_and_duration() {
        let request = UploadVerification::mp4(4096, 10.0, false, "\"owned-etag\"".into()).unwrap();
        let mut receipt = response(&request);
        assert!(
            request
                .verified_receipt("owned-video", &receipt)
                .unwrap()
                .is_some()
        );
        receipt["verification"]["fileSize"] = json!(4095);
        assert!(request.verified_receipt("owned-video", &receipt).is_err());
        receipt["verification"]["fileSize"] = json!(4096);
        receipt["verification"]["duration"] = json!(9.0);
        assert!(request.verified_receipt("owned-video", &receipt).is_err());
        assert!(UploadVerification::mp4(0, 10.0, false, "\"owned-etag\"".into()).is_err());
        assert!(UploadVerification::mp4(4096, f64::NAN, false, "\"owned-etag\"".into()).is_err());
    }
    #[test]
    fn mp4_generation_is_required_and_cannot_be_replaced_by_matching_size_and_duration() {
        let request = UploadVerification::mp4(4096, 10.0, false, "\"original\"".into()).unwrap();
        let mut changed = response(&request);
        changed["verification"]["artifact"]["objectIdentity"] = json!("\"replacement\"");
        assert!(request.verified_receipt("owned-video", &changed).is_err());
        for identity in ["", "unquoted", "W/\"weak\"", "\"bad\nheader\""] {
            assert!(UploadVerification::mp4(4096, 10.0, false, identity.into()).is_err());
        }
        let legacy: UploadVerification = serde_json::from_value(json!({"version":1,"artifact":{"kind":"mp4","fileSize":4096,"duration":10.0},"requiredAudio":false})).unwrap();
        assert!(legacy.requires_reupload());
        assert!(
            legacy
                .verified_receipt("owned-video", &response(&legacy))
                .is_err()
        );
    }

    #[test]
    fn drive_generation_comes_only_from_complete_matching_upload_metadata() {
        assert_eq!(
            completed_drive_object_identity(
                &json!({"id":"drive-file","version":"12","size":"4096"}),
                4096
            ),
            Some("\"drive-file:12\"".into())
        );
        for value in [
            json!({"id":"drive-file","size":"4096"}),
            json!({"id":"drive-file","version":"12","size":"4095"}),
            json!({"id":"other\"file","version":"12","size":"4096"}),
        ] {
            assert!(completed_drive_object_identity(&value, 4096).is_none());
        }
    }

    #[test]
    fn weak_audio_receipt_cannot_satisfy_a_stronger_request_for_the_same_object() {
        let weak = UploadVerification::mp4(4096, 10.0, false, "\"same-object\"".into()).unwrap();
        let strong = UploadVerification::mp4(4096, 10.0, true, "\"same-object\"".into()).unwrap();
        let mut receipt = response(&weak);
        assert_eq!(receipt["verification"]["hasAudio"], json!(true));
        assert_eq!(receipt["verification"]["fullDecode"], json!(true));
        assert!(
            weak.verified_receipt("owned-video", &receipt)
                .unwrap()
                .is_some()
        );
        assert!(strong.verified_receipt("owned-video", &receipt).is_err());
        assert!(
            receipt["verification"]
                .as_object_mut()
                .unwrap()
                .remove("requiredAudioVerified")
                .is_some()
        );
        assert!(
            weak.verified_receipt("owned-video", &receipt)
                .unwrap()
                .is_some()
        );
        assert!(strong.verified_receipt("owned-video", &receipt).is_err());
        receipt["verification"]["requiredAudioVerified"] = json!(true);
        assert!(
            strong
                .verified_receipt("owned-video", &receipt)
                .unwrap()
                .is_some()
        );
    }
}
