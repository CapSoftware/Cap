const fs = require("node:fs");
const path = require("node:path");
const {
	withDangerousMod,
	withEntitlementsPlist,
	withInfoPlist,
	withXcodeProject,
} = require("expo/config-plugins");

const targetName = "CapScreenBroadcast";
const defaultAppGroup = "group.so.cap.mobile.screen-recording";
const defaultExtensionBundleIdentifier = "so.cap.mobile.screen-broadcast";

const unquote = (value) =>
	typeof value === "string" ? value.replace(/^"|"$/g, "") : value;

const findTarget = (project) =>
	Object.entries(project.pbxNativeTargetSection()).find(
		([key, value]) =>
			!key.endsWith("_comment") && unquote(value.name) === targetName,
	);

const extensionBuildConfigurations = (project, target) => {
	const configurationList =
		project.pbxXCConfigurationList()[
			target.pbxNativeTarget.buildConfigurationList
		];
	const configurations = project.pbxXCBuildConfigurationSection();
	return configurationList.buildConfigurations.map(
		({ value }) => configurations[value],
	);
};

const removeSourceFromTarget = (project, targetUuid, fileName) => {
	const sources = project.pbxSourcesBuildPhaseObj(targetUuid);
	if (!sources) return;
	const removedBuildFileUuids = new Set(
		sources.files
			.filter((file) => file.comment === `${fileName} in Sources`)
			.map((file) => file.value),
	);
	sources.files = sources.files.filter(
		(file) => !removedBuildFileUuids.has(file.value),
	);
	const buildFiles = project.pbxBuildFileSection();
	for (const uuid of removedBuildFileUuids) {
		delete buildFiles[uuid];
		delete buildFiles[`${uuid}_comment`];
	}
};

const configureTargetAttributes = (
	project,
	targetUuid,
	developmentTeam,
	capabilityNames,
) => {
	const projectObject = Object.entries(project.pbxProjectSection()).find(
		([key]) => !key.endsWith("_comment"),
	)?.[1];
	if (!projectObject) {
		throw new Error("Cap screen recording could not find the iOS project.");
	}
	projectObject.attributes ??= {};
	projectObject.attributes.TargetAttributes ??= {};
	const targetAttributes =
		projectObject.attributes.TargetAttributes[targetUuid] ?? {};
	targetAttributes.ProvisioningStyle = "Automatic";
	if (developmentTeam) {
		targetAttributes.DevelopmentTeam = developmentTeam;
	}
	targetAttributes.SystemCapabilities = {
		...targetAttributes.SystemCapabilities,
		...Object.fromEntries(
			capabilityNames.map((name) => [name, { enabled: 1 }]),
		),
	};
	projectObject.attributes.TargetAttributes[targetUuid] = targetAttributes;
};

const addExtensionTarget = (
	project,
	extensionBundleIdentifier,
	deploymentTarget,
	marketingVersion,
	usesAppleSignIn,
) => {
	const applicationTargetEntry = Object.entries(
		project.pbxNativeTargetSection(),
	).find(
		([key, value]) =>
			!key.endsWith("_comment") &&
			unquote(value.productType) === "com.apple.product-type.application",
	);
	const applicationTarget = applicationTargetEntry?.[1];
	const applicationConfigurations = applicationTarget
		? extensionBuildConfigurations(project, {
				pbxNativeTarget: applicationTarget,
			})
		: [];
	const existingTarget = findTarget(project);
	const target = existingTarget
		? { uuid: existingTarget[0], pbxNativeTarget: existingTarget[1] }
		: project.addTarget(
				targetName,
				"app_extension",
				targetName,
				extensionBundleIdentifier,
			);
	if (existingTarget) {
		removeSourceFromTarget(
			project,
			target.uuid,
			"ScreenUploadCoordinator.swift",
		);
	}

	for (const configuration of applicationConfigurations) {
		configuration.buildSettings.CODE_SIGN_STYLE = "Automatic";
	}
	if (!existingTarget) {
		project.addBuildPhase(
			[
				`${targetName}/SampleHandler.swift`,
				`${targetName}/SegmentedScreenWriter.swift`,
			],
			"PBXSourcesBuildPhase",
			"Sources",
			target.uuid,
		);
		project.addBuildPhase(
			[
				"AVFoundation.framework",
				"CoreImage.framework",
				"ImageIO.framework",
				"ReplayKit.framework",
				"UniformTypeIdentifiers.framework",
			],
			"PBXFrameworksBuildPhase",
			"Frameworks",
			target.uuid,
		);
	}

	for (const configuration of extensionBuildConfigurations(project, target)) {
		const applicationConfiguration = applicationConfigurations.find(
			(candidate) => candidate.name === configuration.name,
		);
		configuration.buildSettings.APPLICATION_EXTENSION_API_ONLY = "YES";
		configuration.buildSettings.CODE_SIGN_ENTITLEMENTS = `"${targetName}/${targetName}.entitlements"`;
		configuration.buildSettings.CODE_SIGN_STYLE = "Automatic";
		configuration.buildSettings.CURRENT_PROJECT_VERSION =
			applicationConfiguration?.buildSettings.CURRENT_PROJECT_VERSION ?? "1";
		configuration.buildSettings.DEFINES_MODULE = "YES";
		if (applicationConfiguration?.buildSettings.DEVELOPMENT_TEAM) {
			configuration.buildSettings.DEVELOPMENT_TEAM =
				applicationConfiguration.buildSettings.DEVELOPMENT_TEAM;
		}
		configuration.buildSettings.GENERATE_INFOPLIST_FILE = "NO";
		configuration.buildSettings.INFOPLIST_FILE = `"${targetName}/Info.plist"`;
		configuration.buildSettings.IPHONEOS_DEPLOYMENT_TARGET = deploymentTarget;
		configuration.buildSettings.MARKETING_VERSION =
			marketingVersion ??
			applicationConfiguration?.buildSettings.MARKETING_VERSION ??
			"1.0";
		configuration.buildSettings.PRODUCT_BUNDLE_IDENTIFIER = `"${extensionBundleIdentifier}"`;
		configuration.buildSettings.SDKROOT = "iphoneos";
		configuration.buildSettings.SKIP_INSTALL = "YES";
		configuration.buildSettings.SWIFT_VERSION = "5.0";
		configuration.buildSettings.TARGETED_DEVICE_FAMILY = '"1"';
	}

	const developmentTeam = applicationConfigurations.find(
		(configuration) => configuration.buildSettings.DEVELOPMENT_TEAM,
	)?.buildSettings.DEVELOPMENT_TEAM;
	if (applicationTargetEntry) {
		configureTargetAttributes(
			project,
			applicationTargetEntry[0],
			developmentTeam,
			[
				"com.apple.ApplicationGroups.iOS",
				...(usesAppleSignIn ? ["com.apple.SignInWithApple"] : []),
			],
		);
	}
	configureTargetAttributes(project, target.uuid, developmentTeam, [
		"com.apple.ApplicationGroups.iOS",
	]);
};

const copyExtensionSources = (
	projectRoot,
	appGroup,
	extensionBundleIdentifier,
) => {
	const sourceDirectory = path.join(__dirname, "..", "extension", targetName);
	const destinationDirectory = path.join(projectRoot, "ios", targetName);
	fs.rmSync(destinationDirectory, { force: true, recursive: true });
	fs.mkdirSync(destinationDirectory, { recursive: true });
	for (const fileName of [
		"SampleHandler.swift",
		"SegmentedScreenWriter.swift",
	]) {
		fs.copyFileSync(
			path.join(sourceDirectory, fileName),
			path.join(destinationDirectory, fileName),
		);
	}
	for (const fileName of ["Info.plist", `${targetName}.entitlements`]) {
		const contents = fs
			.readFileSync(path.join(sourceDirectory, fileName), "utf8")
			.replaceAll("__APP_GROUP__", appGroup)
			.replaceAll("__EXTENSION_BUNDLE_IDENTIFIER__", extensionBundleIdentifier);
		fs.writeFileSync(path.join(destinationDirectory, fileName), contents);
	}
};

const addEasExtension = (config, extensionBundleIdentifier, appGroup) => {
	const extensions =
		config.extra?.eas?.build?.experimental?.ios?.appExtensions ?? [];
	const nextExtension = {
		targetName,
		bundleIdentifier: extensionBundleIdentifier,
		entitlements: {
			"com.apple.security.application-groups": [appGroup],
		},
	};
	const appExtensions = [
		...extensions.filter((extension) => extension.targetName !== targetName),
		nextExtension,
	];
	config.extra = {
		...config.extra,
		eas: {
			...config.extra?.eas,
			build: {
				...config.extra?.eas?.build,
				experimental: {
					...config.extra?.eas?.build?.experimental,
					ios: {
						...config.extra?.eas?.build?.experimental?.ios,
						appExtensions,
					},
				},
			},
		},
	};
	return config;
};

module.exports = (
	config,
	{
		appGroup = defaultAppGroup,
		extensionBundleIdentifier = defaultExtensionBundleIdentifier,
	} = {},
) => {
	addEasExtension(config, extensionBundleIdentifier, appGroup);
	config = withEntitlementsPlist(config, (entitlementsConfig) => {
		const groups = new Set(
			entitlementsConfig.modResults["com.apple.security.application-groups"] ??
				[],
		);
		groups.add(appGroup);
		entitlementsConfig.modResults["com.apple.security.application-groups"] = [
			...groups,
		];
		delete entitlementsConfig.modResults[
			"com.apple.developer.screen-recording"
		];
		return entitlementsConfig;
	});
	config = withInfoPlist(config, (infoConfig) => {
		const backgroundModes = (
			infoConfig.modResults.UIBackgroundModes ?? []
		).filter((mode) => mode !== "audio" && mode !== "screen-capture");
		if (backgroundModes.length > 0) {
			infoConfig.modResults.UIBackgroundModes = backgroundModes;
		} else {
			delete infoConfig.modResults.UIBackgroundModes;
		}
		infoConfig.modResults.CapScreenRecordingAppGroup = appGroup;
		infoConfig.modResults.CapScreenBroadcastExtensionBundleIdentifier =
			extensionBundleIdentifier;
		infoConfig.modResults.NSScreenCaptureUsageDescription =
			"Cap records your screen after you confirm Start Broadcast.";
		return infoConfig;
	});
	config = withDangerousMod(config, [
		"ios",
		async (dangerousConfig) => {
			copyExtensionSources(
				dangerousConfig.modRequest.projectRoot,
				appGroup,
				extensionBundleIdentifier,
			);
			return dangerousConfig;
		},
	]);
	config = withXcodeProject(config, (xcodeConfig) => {
		addExtensionTarget(
			xcodeConfig.modResults,
			extensionBundleIdentifier,
			xcodeConfig.ios?.deploymentTarget ?? "15.1",
			config.version,
			config.ios?.usesAppleSignIn === true,
		);
		return xcodeConfig;
	});
	return config;
};
