/**
 * ProtoFlow config plugin. Continuous Native Generation rewrites ios/ and android/ on every prebuild, so the native
 * settings acceptance needs live here instead of in hand-edited native files.
 *
 * Android: ProtoFlow fails a step whose process group outlives it, so Gradle and Kotlin must not leave daemons behind;
 * the emulator is arm64, so one ABI keeps the release build short.
 */
const { withGradleProperties } = require('expo/config-plugins');

const GRADLE = {
  'org.gradle.daemon': 'false',
  'kotlin.compiler.execution.strategy': 'in-process',
  reactNativeArchitectures: 'arm64-v8a'
};

module.exports = function withProtoFlow(config) {
  return withGradleProperties(config, gradle => {
    for (const [key, value] of Object.entries(GRADLE)) {
      gradle.modResults = gradle.modResults.filter(item => !(item.type === 'property' && item.key === key));
      gradle.modResults.push({ type: 'property', key, value });
    }
    return gradle;
  });
};
