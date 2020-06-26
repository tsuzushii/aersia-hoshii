export interface NewTrack {
    id: number,
    game: string,
    title: string,
    comp: string,
    arr: string,
    file: string,
    s_id: number,
    s_title: string,
    s_file: string,
}
export class PlaylistMetaData{
    changelog: string
    url: string
    ext: string
    new_id?: string

    constructor(changelog: string, url: string, ext: string, new_id?: string) {
        this.changelog = changelog
        this.url = url
        this.ext = ext
        this.new_id = new_id
    }
}