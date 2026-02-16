# Piston Maven

Spoof maven repository backed by minecraft.net's launcher version manifest data. Reverse engineers release (and snapshot) client, server, and their respective libraries into a maven POM for easy acquisition in IDE.

Note that piston-maven is most useful for version 26.1 and onward, where the game is no longer obfuscated.

## Usage

### Gradle

In your `build.gradle.kts`:
```kotlin
repositories {
    maven("https://piston-maven.hugeblank.dev")
    mavenCentral()
}

dependencies {
    // All versions of the game are supported
    implementation("net.minecraft:client:1.8")
    // Obtaining the server is also supported. (Note: Versions prior to 1.2.5 do not have a server version.)
    implementation("net.minecraft:server:1.8")
}
```