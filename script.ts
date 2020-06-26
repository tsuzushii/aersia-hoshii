#!/usr/bin/env node
import * as fs from "fs";
import axios from "axios";
import * as parser from "xml2js"
import { OldTrack } from "./models/old-track.model"
import { NewTrack, PlaylistMetaData } from "./models/new-track.model"
import { sanitize } from "sanitize-filename-ts";
const taglib = require('taglib3')

const playlistsObject = {
    VIP: "https://www.vipvgm.net/roster.min.json",
    Source: "",
    Mellow: "https://www.vipvgm.net/roster-mellow.min.json",
    Exiled: "https://www.vipvgm.net/roster-exiled.min.json",
    WAP: "https://wap.aersia.net/roster.xml",
    CPP: "https://cpp.aersia.net/roster.xml",
};

//convert to array 
const newPlaylists = Object.entries(playlistsObject).splice(0, 4)
const oldPlaylists = Object.entries(playlistsObject).splice(4, 2)
//mellow & exiled job
let getMellowAndExiledJob = (playlist) => {
    return new Promise(async (resolve) => {
        axios.get(playlist[1]).then(async (res) => {
            const MAX_RETRY = 1000;
            let count = 1
            let currentRetry = 0;
            let meta: PlaylistMetaData = new PlaylistMetaData(res.data.changelog, res.data.url, res.data.ext, res.data.new_id)
            let tracks: NewTrack[] = res.data.tracks

            //if 5xx retry
            function errorHandler(track: NewTrack) {
                if (currentRetry < MAX_RETRY) {
                    currentRetry++;
                    downloadMellowOrExiledTrack(track);
                }
                else {
                    console.log(currentRetry)
                    currentRetry = 0
                    console.log("something wen't wrong with" + track.title)
                }
            }
            async function downloadMellowOrExiledTrack(track: NewTrack) {
                let downloadUrl = meta.url + track.file + "." + meta.ext
                await axios.get(downloadUrl, { responseType: "arraybuffer", headers: { 'Content-Type': 'audio/m4a' } }).then((res) => {
                    let fileName = sanitize(track.game + " - " + track.title)
                    let metaFix: Array<string> = track.title.split(" - ")
                    let filePath = "./Aersia Playlists/" + playlist[0] + "/" + fileName + "." + meta.ext
                    if (!track.file.includes("../")) {
                        if (metaFix.length == 2)
                        {
                            fs.writeFileSync(filePath, res.data)
                            taglib.writeTags(filePath, { title: [metaFix[1]], artist: [metaFix[0]], album: [track.game] })
                            currentRetry = 0
                            console.log("Succesfully downloaded track n°" + count + ": " + track.game + " - " + metaFix[1])
                        }
                        else {
                            fs.writeFileSync(filePath, res.data)
                            taglib.writeTags(filePath, { title: [track.title], artist: [track.comp], album: [track.game] })
                            currentRetry = 0
                            console.log("Succesfully downloaded track n°" + count + ": " + track.game + " - " + track.title)
                        }
                        
                    }
                    else {
                        if (metaFix.length == 2)
                        {
                        console.log("Skipped track n°" + count + ": " + track.game + " - " + metaFix[1] + " => already exists in VIP")
                    }
                    else 
                    {
                        console.log("Skipped track n°" + count + ": " + track.game + " - " + track.title + " => already exists in VIP")

                        }
                    }
                    count++
                }).catch(err => {
                    errorHandler(track)
                })
            }
            for (let track of tracks) {
                await sleep(500).then(() => {
                    downloadMellowOrExiledTrack(track).then(() => {
                        if (count - 1 == tracks.length) {
                            console.log("----------------------------------------------------------------------------------------------")
                            console.log("The " + (count - 1) + "/" + tracks.length + " tracks of the " + tracks[0].game + " - " + tracks[0].title + " have been successfully downloaded!")
                            console.log("----------------------------------------------------------------------------------------------")
                            resolve()
                        }
                    })

                })
            }
        })
    })
}
//vip & source job
let getVIPandSourceJob = (playlist) => {
    return new Promise(async (resolve) => {
        console.log("Creating " + newPlaylists[1][0] + " Folder...")
        createFolderJob(newPlaylists[1])
        axios.get(playlist[1]).then(async (res) => {
            const MAX_RETRY = 1000;
            let count = 1
            let currentRetry = 0;
            let meta: PlaylistMetaData = new PlaylistMetaData(res.data.changelog, res.data.url, res.data.ext, res.data.new_id)
            let tracks: NewTrack[] = res.data.tracks

            //if 5xx retry
            function errorHandler(track: NewTrack) {
                if (currentRetry < MAX_RETRY) {
                    currentRetry++;
                    downloadVIPTrack(track);
                }
                else {
                    console.log(currentRetry)
                    currentRetry = 0
                    console.log("something wen't wrong with" + track)
                }
            }
            async function downloadVIPTrack(track: NewTrack) {
                let downloadUrlVIP = meta.url + track.file + "." + meta.ext
                await axios.get(downloadUrlVIP, { responseType: "arraybuffer", headers: { 'Content-Type': 'audio/m4a' } }).then((res) => {
                    let fileNameVIP = sanitize(track.game + " - " + track.title) + "." + meta.ext
                    let filePathVIP = "./Aersia Playlists/" + playlist[0] + "/" + fileNameVIP
                    fs.writeFileSync(filePathVIP, res.data)
                    taglib.writeTags(filePathVIP, { title: [track.title], artist: [track.comp], album: [track.game] })
                    currentRetry = 0
                    console.log("Succesfully downloaded track n°" + count + ": " + track.game + " - " + track.title)
                    count++
                }).catch(err => {
                    errorHandler(track)
                })
            }
            async function downloadSourceTrack(track: NewTrack) {
                let downloadUrlSource = meta.url + "source/" + track.s_file + "." + meta.ext
                await axios.get(downloadUrlSource, { responseType: "arraybuffer", headers: { 'Content-Type': 'audio/m4a' } }).then((res) => {
                    let fileNameSource = sanitize(track.game + " - " + track.s_title) + "." + meta.ext
                    let filePathSource = "./Aersia Playlists/" + newPlaylists[1][0] + "/" + fileNameSource
                    fs.writeFileSync(filePathSource, res.data)
                    taglib.writeTags(filePathSource, { title: [track.s_title], artist: [track.comp], album: [track.game] })
                    currentRetry = 0
                }).catch(err => {
                    errorHandler(track)
                })
            }
            //get each track

            for (let track of tracks) {
                if ("s_id" in track) {
                    await sleep(500).then(() => {
                        downloadVIPTrack(track).then(() => {
                            downloadSourceTrack(track)
                        })
                    })

                }
                else {
                    //delay per request to avoid overloading server
                    await sleep(500).then(() => {
                        downloadVIPTrack(track).then(() => {
                            if (count - 1 == tracks.length) {
                                console.log("----------------------------------------------------------------------------------------------")
                                console.log("The " + (count - 1) + "/" + tracks.length + " tracks of the " + tracks[0].game + " - " + tracks[0].title + " have been successfully downloaded!")
                                console.log("----------------------------------------------------------------------------------------------")
                                resolve()
                            }
                        })
                    })
                }

            }
        })
    })
}


//create folder job
let createFolderJob = (playlist) => {
    fs.mkdir("./Aersia Playlists/" + playlist[0], { recursive: true }, (err) => {
        if (err) {
            throw err;
        }
    })
}

// anime & cpp job 

let getOldPlaylistsJob = (playlist) => {
    return new Promise(async (resolve) => {
        //get xml
        axios.get(playlist[1]).then(async (res) => {
            let xml: string = res.data
            //parse xml
            parser.parseString(xml, { trim: true }, async (err, res) => {
                const MAX_RETRY = 1000;
                let currentRetry = 0;
                let count = 1
                const tracks: OldTrack[] = res.playlist["trackList"][0].track

                //if 5xx retry
                function errorHandler(track: OldTrack) {
                    if (currentRetry < MAX_RETRY) {
                        currentRetry++;
                        downloadOldTrack(track);
                    }
                    else {
                        console.log(currentRetry)
                        currentRetry = 0
                        console.log("something wen't wrong with" + track)
                    }
                }

                //get track
                async function downloadOldTrack(track: OldTrack) {
                    await axios.get(track.location[0], { responseType: "arraybuffer", headers: { 'Content-Type': 'audio/m4a' } }).then((res) => {
                        //name file
                        let filename = sanitize(`${track.creator[0]} - ${track.title[0]}`)
                        let filePath: string = "./Aersia Playlists/" + playlist[0] + "/" + filename + ".m4a"
                        let meta: Array<string> = filename.split(" - ")

                        // Write file & add metadata 
                        if (meta.length == 2 || track.creator[0] == "Independence Day") {

                            fs.writeFileSync(filePath, res.data)
                            taglib.writeTags(filePath, { title: track.title, album: track.creator })
                            currentRetry = 0
                            console.log("Succesfully downloaded track n°" + count + ": " + track.creator[0] + " - " + track.title[0])
                        }
                        else {
                            if (meta.length == 3)
                            {
                                filePath = "./Aersia Playlists/" + playlist[0] + "/" + meta[0] + " - " + meta[2] + ".m4a"
                                fs.writeFileSync(filePath, res.data)
                                taglib.writeTags(filePath, { title: [meta[2]], artist: [meta[1]], album: [meta[0]] })
                                currentRetry = 0
                                console.log("Succesfully downloaded track n°" + count + ": " + meta[0] + " - " + meta[2])
                            }
                            else
                            // too lazy to clean data
                            {
                                filePath = "./Aersia Playlists/" + playlist[0] + "/" + meta[0] + " - " + meta[3] + ".m4a"
                                fs.writeFileSync(filePath, res.data)
                                taglib.writeTags(filePath, { title: [meta[3]], artist: [meta[2]], album: [meta[1]] })
                                currentRetry = 0
                                console.log("Succesfully downloaded track n°" + count + ": " + meta[0] + " - " + meta[3])
                            }
                        }
                        count++
                    }).catch(() => {
                        errorHandler(track)
                    })
                }

                //get each track

                for (let track of tracks) {
                    //delay per request to avoid overloading server
                    await sleep(500).then(() => {
                        downloadOldTrack(track).then(() => {
                            if (count - 1 == tracks.length) {
                                console.log("----------------------------------------------------------------------------------------------")
                                console.log("The " + (count - 1) + "/" + tracks.length + " tracks of the " + tracks[0].creator[0] + " have been successfully downloaded!")
                                console.log("----------------------------------------------------------------------------------------------")
                                resolve()
                            }
                        })
                    })
                }
            })
        })
    })
}
// utilty 
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    })
}
// aersia hoshii routine
async function aersia_hoshii(oldPlaylists, newPlaylists) {
    for (let newPlaylist of newPlaylists) {
        if (newPlaylist[0] != "Source") {
            console.log("Creating " + newPlaylist[0] + " Folder...")
            createFolderJob(newPlaylist)
            if (newPlaylist[0] == "VIP") {
                console.log("Start downloading playlist: " + newPlaylist[0])
                await getVIPandSourceJob(newPlaylist)
            }
            else {
                console.log("Start downloading playlist: " + newPlaylist[0])
                await getMellowAndExiledJob(newPlaylist)
            }
        }
        else {
            continue;
        }
    }
    for (let oldPlaylist of oldPlaylists) {
        console.log("Creating " + oldPlaylists[0] + " Folder...")
        createFolderJob(oldPlaylist)
        console.log("Start downloading playlist: " + oldPlaylist[0])
        await getOldPlaylistsJob(oldPlaylist)
    }
    console.log("ほんまに汗をかけた、もう寝るわ！")
}
// aersia hoshii!
aersia_hoshii(oldPlaylists, newPlaylists)