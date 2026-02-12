import express from 'express'
import * as z from 'zod'
import * as crypto from 'crypto'


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
    let xml = `<?xml version="1.0" encoding="UTF-28"?><manifest><groupId>net.minecraft</groupId><artifactId>${envtype}</artifactId><versioning><latest>${manifest.latest.snapshot}</latest><release>${manifest.latest.release}</release><versions>`
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
    let xml = `<?xml version="1.0" encoding="UTF-8"?><project xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd" xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
    xml += `<modelVersion>4.0.0</modelVersion><groupId>net.minecraft</groupId><artifactId>${envtype}</artifactId><version>${versionIndex.id}</version><dependencies>`
    let i = 0;
    for (const library of versionIndex.libraries) {
        const gav = library.name.split(":")
        // if (gav.length > 3) continue
        xml += `<dependency><groupId>${gav[0]}</groupId><artifactId>${gav[1]}</artifactId><version>${gav[2]}</version><scope>runtime</scope>`
        if (gav.length > 3) xml += `<classifier>${gav[3]}</classifier>`
        xml += `</dependency>`
        i++;
    }
    xml += `</dependencies></project>`
    return xml
}

async function getVersionIndex(version: Version) {
    return await versionIndexType.parseAsync(await (await fetch(version.url)).json())
}

function notFound(req: any, res: any) {
    res.sendStatus(404)
    if (req.method !== "HEAD") {
        res.send("Not found")
    }
}

app.all(/.*/, (req, res, next) => {
    console.log(req.method, req.path)
    next()
    // console.log("response", req.method, req.path, res.statusCode)
})

app.all('/net/minecraft/:envtype/maven-metadata.xml', async (req, res) => {
    if (req.params.envtype === "client" || req.params.envtype === "server") {
        const xml = manifestToXML(await manifestCache.get(), req.params.envtype)

        res.set('Content-Type', 'application/xml');
        res.setHeader("Content-Length", xml.length)
        if (req.method === "HEAD") {
            res.send()
            return
        } else if (req.method === "GET") {
            res.send(xml)
            return
        }
    }
    notFound(req, res)
})

app.get('/net/minecraft/:envtype/:version/:file', async (req, res) => {
    if (!(req.params.envtype === "client" || req.params.envtype === "server")) {
        notFound(req, res)
        return;
    }

    let versionIndex: VersionIndex;
    if (versionIndexCache.has(req.params.version)) {
        versionIndex = versionIndexCache.get(req.params.version)!
    } else {
        const version = getVersion(await manifestCache.get(), req.params.version)
        if (version === null) {
            notFound(req, res)
            return
        }
        versionIndex = await getVersionIndex(version)
        versionIndexCache.set(version.id, versionIndex)
    }

    const name = `${req.params.envtype}-${req.params.version}`
    const download = versionIndex.downloads[req.params.envtype]

    if (`${name}.jar` === req.params.file) {
        const url = download?.url
        if (!url) {
            notFound(req, res)
            return
        }
        res.redirect(url)
        return
    }

    const pom = versionIndexToPom(versionIndex, req.params.envtype)
    if (`${name}.pom` === req.params.file) {
        res.set('Content-Type', 'application/xml');
        res.setHeader("Content-Length", pom.length)
        if (req.method === "HEAD") {
            res.send()
            return
        } else if (req.method === "GET") {
            res.send(pom)
            return
        }
    } else if (`${name}.pom.sha1` === req.params.file) {
        const pomsha = crypto.createHash('sha1').update(pom).digest("hex")
        res.set('Content-Type', 'application/octet-stream');
        res.setHeader("Content-Length", pomsha.length)
        if (req.method === "HEAD") {
            res.send()
            return
        } else if (req.method === "GET") {
            res.send(pomsha)
            return
        }
    }
    notFound(req, res)
})

app.get(/.*/, (req, res) => {
    const to = "https://libraries.minecraft.net" + req.path
    console.log(to)
    res.redirect(to)
})

app.listen(3000, () => {
    console.log('Server is running on http://localhost:3000')
})