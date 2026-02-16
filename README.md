# Piston Maven

Spoof maven repository backed by minecraft.net's launcher version manifest data. Reverse engineers game client/server and libraries into a maven POM for easy acquisition in IDE.

Note that piston-maven is most useful for version 26.1 and onward, where the game is no longer deobfuscated.

## Usage

### Gradle

In your `build.gradle.kts`:
```kotlin
repositories {
    maven("https://piston-maven.hugeblank.dev")
    mavenCentral()
}

dependencies {
    // Any version from latest - 1.8 Supported
    implementation("net.minecraft:client:1.8")
    // Obtaining the server is also supported.
    implementation("net.minecraft:server:1.8")
}
```