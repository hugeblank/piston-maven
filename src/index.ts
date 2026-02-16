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
            classifiers: z.optional(z.record(z.string(), downloadType))
        })
    }))
})

type VersionIndex = z.infer<typeof versionIndexType>

type Version = z.infer<typeof versionType>

type Manifest = z.infer<typeof manifestType>

const versionIndexCache: Map<string, VersionIndex> = new Map()

class ManifestCache {
    private manifest: Manifest|null = null;

    constructor() {
    
    }
    
    public async get() {
        if (this.manifest === null) {
            this.manifest = await manifestType.parseAsync(await (await fetch("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json")).json())
            setTimeout(this.clear, 1000*60*5)
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
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<manifest>\n\t<groupId>net.minecraft</groupId>\n\t<artifactId>${envtype}</artifactId>\n\t<versioning>\n\t\t<latest>${manifest.latest.snapshot}</latest>\n\t\t<release>${manifest.latest.release}</release>\n\t\t<versions>`
    for (const version of manifest.versions) {
        // 1.2.4 & earlier do not have a server
        if (version.id === "1.2.4" && envtype === "server") break;
        xml += `\n\t\t\t<version>${version.id}</version>`
    }
    xml += "\n\t\t</versions>"
    const latest = getVersion(manifest, manifest.latest.snapshot)!.releaseTime
    xml += `\n\t\t<lastUpdated>${latest.getFullYear()}${latest.getMonth()}${latest.getDay()}${latest.getHours()}${latest.getMinutes()}${latest.getSeconds()}</lastUpdated>`
    xml += "\n\t</versioning>\n</manifest>"
    return xml
}

function versionIndexToPom(versionIndex: VersionIndex, envtype: "client" | "server") {
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<project xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd" xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n\t`
    xml += `<modelVersion>4.0.0</modelVersion>\n\t<groupId>net.minecraft</groupId>\n\t<artifactId>${envtype}</artifactId>\n\t<version>${versionIndex.id}</version>\n\t<dependencies>\n`
    let i = 0;
    for (const library of versionIndex.libraries) {
        const gav = library.name.split(":")
        
        // Every version after 1.7.3 has these stupid broken versions of LWJGL, AND a correct version (2.9.0). Mojang my beloved, pls fix. 
        if (gav[2].includes("2.9.1-nightly-20130708-debug3") || gav[2].includes("2.9.1-nightly-20131017")) continue; // skip.

        xml += `\t\t<dependency>\n\t\t\t<groupId>${gav[0]}</groupId>\n\t\t\t<artifactId>${gav[1]}</artifactId>\n\t\t\t<version>${gav[2]}</version>\n\t\t\t<scope>runtime</scope>\n`
        if (library.downloads.classifiers === undefined) {
            if (gav.length > 3) xml += `\t\t\t<classifier>${gav[3]}</classifier>\n`
        } else {
            for (const [key, _] of Object.entries(library.downloads.classifiers)) {
                xml += `\t\t\t<classifier>${key}</classifier>\n`
            }
        }
        xml += `\t\t</dependency>\n`
        i++;
    }
    xml += `\t</dependencies>\n</project>\n`
    return xml
}

async function getVersionIndex(version: Version) {
    return await versionIndexType.parseAsync(await (await fetch(version.url)).json())
}

app.all('/net/minecraft/:envtype/maven-metadata.xml', async (req, res) => {
    console.log(req.method, req.path)
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
    res.sendStatus(404)
})

app.get('/net/minecraft/:envtype/:version/:file', async (req, res) => {
    console.log(req.method, req.path)
    if (req.params.envtype === "launchwrapper") {
        res.redirect("https://libraries.minecraft.net" + req.path)
        return
    }

    if (!(req.params.envtype === "client" || req.params.envtype === "server")) {
        res.sendStatus(404)
        return;
    }

    let versionIndex: VersionIndex;
    if (versionIndexCache.has(req.params.version)) {
        versionIndex = versionIndexCache.get(req.params.version)!
    } else {
        const version = getVersion(await manifestCache.get(), req.params.version)
        if (version === null) {
            res.sendStatus(404)
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
            res.sendStatus(404)
            return
        }
        res.redirect(url)
        return
    }

    const pom = versionIndexToPom(versionIndex, req.params.envtype)
    if (`${name}.pom` === req.params.file) {
        res.set('Content-Type', 'application/octet-stream');
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
    res.sendStatus(404)
})

app.get(/.*/, async (req, res) => {
    console.log(req.method, req.path)
    res.redirect("https://libraries.minecraft.net" + req.path)
})

app.listen(3000, () => {
    console.log('Server is running on http://localhost:3000')
})