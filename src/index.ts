import express from 'express'
import * as z from 'zod'


const app = express()

const versionType = z.object({
    id: z.string(),
    type: z.literal(["release", "snapshot", "old_beta", "old_alpha"]),
    url: z.url(),
    time: z.iso.datetime({ offset: true }).transform((str) => new Date(str)),
    releaseTime: z.iso.datetime({ offset: true }).transform((str) => new Date(str)),
    sha1: z.hash("sha1"),
    complianceLevel: z.int()
})

const manifestType = z.object({
    latest: z.object({
        release: z.string(),
        snapshot: z.string()
    }),
    versions: z.array(versionType)
})

const downloadType = z.object({
    size: z.int(),
    url: z.url(),
    sha1: z.hash("sha1")
})

const versionIndexType = z.object({
    downloads: z.object({
        client: downloadType,
        server: downloadType.optional()
    }),
    id: z.string(),
    libraries: z.array(z.object({
        name: z.string(),
        downloads: z.object({
            artifact: downloadType.extend({
                path: z.string()
            }),
        })
    }))
})

type VersionIndex = z.infer<typeof versionIndexType>

type Version = z.infer<typeof versionType>

type Manifest = z.infer<typeof manifestType>

const versionIndexCache: Map<string, VersionIndex> = new Map()

class ManifestCache {
    private manifest: Manifest|null = null;

    public ManifestCache() { }
    
    public async get() {
        if (this.manifest === null) {
            this.manifest = await manifestType.parseAsync(await (await fetch("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json")).json())
            setTimeout(this.clear, 1000)
        }
        return this.manifest
    }

    private clear() {
        this.manifest = null
    }

}

const manifestCache = new ManifestCache()

function getVersion(manifest: Manifest, version: string): Version|null {
    for (let i = 0; i < manifest.versions.length; i++) {
        const v = manifest.versions[i];
        if (v.id === version) return v
    }
    return null
}

function manifestToXML(manifest: Manifest, envtype: "client" | "server") {
    let xml = `<manifest><groupId>net.minecraft</groupId><artifactId>${envtype}</artifactId><versioning><latest>${manifest.latest.snapshot}</latest><release>${manifest.latest.release}</release><versions>`
    for (const version of manifest.versions) {
        // TODO: VersionIndexes at and before this version might not have a `artifact` block, breaking the version index to pom xml logic. Fix it.
        if (version.id === "1.12.2") break;
        // 1.2.5 & earlier do not have a server
        if (version.id === "1.2.4" && envtype === "server") break;
        xml += `<version>${version.id}</version>`
    }
    xml += "</versions>"
    const latest = getVersion(manifest, manifest.latest.snapshot)!.releaseTime
    xml += `<lastUpdated>${latest.getFullYear()}${latest.getMonth()}${latest.getDay()}${latest.getHours()}${latest.getMinutes()}${latest.getSeconds()}</lastUpdated>`
    xml += "</versioning></manifest>"
    return xml
}

function versionIndexToPom(versionIndex: VersionIndex, envtype: "client" | "server") {
    let xml = `<project xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd" xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><modelVersion>4.0.0</modelVersion>`
    xml += `<groupId>net.minecraft</groupId><artifactId>${envtype}</artifactId><version>${versionIndex.id}</version><dependencies>`
    let i = 0;
    for (const library of versionIndex.libraries) {
        const gav = library.name.split(":")
        xml += `<dependency><groupId>${gav[0]}</groupId><artifactId>${gav[1]}</artifactId><version>${gav[2]}</version><scope>runtime</scope></dependency>`
        i++;
    }
    xml += `</dependencies></project>`
    return xml
}

async function getVersionIndex(version: Version) {
    return await versionIndexType.parseAsync(await (await fetch(version.url)).json())
}

app.get('/net/minecraft/:envtype/maven-metadata.xml', async (req, res) => {
    if (req.params.envtype === "client" || req.params.envtype === "server") {
        res.set('Content-Type', 'text/xml');
        res.send(manifestToXML(await manifestCache.get(), req.params.envtype))
    } else {
        res.sendStatus(404).send("Not found")
    }
})

app.get('/net/minecraft/:envtype/:version/:file', async (req, res) => {
    if (!(req.params.envtype === "client" || req.params.envtype === "server")) {
        res.sendStatus(404).send("Not found")
        return;
    }

    let versionIndex: VersionIndex;
    if (versionIndexCache.has(req.params.version)) {
        versionIndex = versionIndexCache.get(req.params.version)!
    } else {
        const version = getVersion(await manifestCache.get(), req.params.version)
        if (version === null) {
            res.status(404).send("Not Found")
            return
        }
        versionIndex = await getVersionIndex(version)
        versionIndexCache.set(version.id, versionIndex)
    }

    if (`${req.params.envtype}-${req.params.version}.jar` === req.params.file) {
        const url = versionIndex.downloads[req.params.envtype]?.url
        if (!url) {
            res.status(404).send("Not Found")
            return
        }
        res.redirect(url)
    } else if (`${req.params.envtype}-${req.params.version}.pom` === req.params.file) {
        res.set('Content-Type', 'text/xml');
        res.send(versionIndexToPom(versionIndex, req.params.envtype))
    }
})

app.get(/.*/, (req, res) => {
  res.redirect("https://libraries.minecraft.net" + req.path)
})

app.listen(3000, () => {
  console.log('Server is running on http://localhost:3000')
})