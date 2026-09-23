const { withAppBuildGradle } = require('expo/config-plugins');
module.exports = config => withAppBuildGradle(config, config => {
  config.modResults.contents = config.modResults.contents.replace(/\n\/\/ @generated begin audio-signing[\s\S]*?\/\/ @generated end audio-signing\n/g, "");
  config.modResults.contents += `
// @generated begin audio-signing
// Signing material lives outside the repository and APK.
android {
  signingConfigs {
    personalRelease {
      if (System.getenv('AUDIO_KEYSTORE')) {
        storeFile file(System.getenv('AUDIO_KEYSTORE'))
        storePassword System.getenv('AUDIO_KEY_PASSWORD')
        keyAlias 'audio-notifications'
        keyPassword System.getenv('AUDIO_KEY_PASSWORD')
      }
    }
  }
  buildTypes { release { signingConfig signingConfigs.personalRelease } }
}
tasks.configureEach { task ->
  if (task.name == 'validateSigningRelease') {
    task.doFirst {
      if (!System.getenv('AUDIO_KEYSTORE')) throw new GradleException('Use npm run build:apk to configure release signing')
    }
  }
}
// @generated end audio-signing
`;
  return config;
});
