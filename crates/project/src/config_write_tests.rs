use crate::ProjectConfiguration;
use std::io::Read;

#[test]
fn replacing_config_keeps_the_previous_file_intact() {
    let project = tempfile::tempdir().unwrap();
    let path = project.path().join("project-config.json");
    let mut config = ProjectConfiguration::default();
    config.write(project.path()).unwrap();
    let original = std::fs::read(&path).unwrap();
    let mut previous = std::fs::File::open(&path).unwrap();
    config.background.padding = 23.0;

    config.write(project.path()).unwrap();

    let mut retained = Vec::new();
    previous.read_to_end(&mut retained).unwrap();
    assert_eq!(retained, original);
    assert_eq!(
        std::fs::read(&path).unwrap(),
        serde_json::to_vec_pretty(&config).unwrap()
    );
    assert_eq!(std::fs::read_dir(project.path()).unwrap().count(), 1);
}

#[test]
fn failed_replacement_keeps_the_destination_and_cleans_up() {
    let project = tempfile::tempdir().unwrap();
    let path = project.path().join("project-config.json");
    std::fs::create_dir(&path).unwrap();
    std::fs::write(path.join("retained"), b"original").unwrap();

    assert!(
        ProjectConfiguration::default()
            .write(project.path())
            .is_err()
    );

    assert_eq!(std::fs::read(path.join("retained")).unwrap(), b"original");
    assert_eq!(std::fs::read_dir(project.path()).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn failed_write_keeps_the_previous_config_and_cleans_up() {
    const CHILD_PROJECT: &str = "CAP_PROJECT_LIMITED_WRITE_TEST";
    if let Some(project) = std::env::var_os(CHILD_PROJECT) {
        let config = ProjectConfiguration::default();
        assert!(serde_json::to_vec_pretty(&config).unwrap().len() > 1024);
        assert!(config.write(project).is_err());
        return;
    }

    let project = tempfile::tempdir().unwrap();
    let path = project.path().join("project-config.json");
    let mut config = ProjectConfiguration::default();
    config.background.padding = 23.0;
    config.write(project.path()).unwrap();
    let original = std::fs::read(&path).unwrap();

    let output = std::process::Command::new("sh")
        .args([
            "-c",
            "trap '' XFSZ; ulimit -f 1; exec \"$@\"",
            "config-write-test",
        ])
        .arg(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "config_write_tests::failed_write_keeps_the_previous_config_and_cleans_up",
        ])
        .env(CHILD_PROJECT, project.path())
        .output()
        .unwrap();

    assert!(output.status.success(), "{output:?}");
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("1 passed"),
        "{output:?}"
    );
    assert_eq!(std::fs::read(path).unwrap(), original);
    assert_eq!(std::fs::read_dir(project.path()).unwrap().count(), 1);
}
