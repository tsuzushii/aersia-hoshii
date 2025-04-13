# Aersia-Hoshii 2.0

An advanced downloader for [Aersia VGM](https://www.vipvgm.net) playlists.

## Installation

### Prerequisites

- Node.js 14.0.0 or higher
- npm or yarn

### Install from source

1. Clone the repository
   ```bash
   git clone https://github.com/soichirou/aersia-hoshii.git
   cd aersia-hoshii
   ```

2. Install dependencies
   ```bash
   npm install
   ```

3. Build the project
   ```bash
   npm run build
   ```

4. Run directly
   ```bash
   npm start
   ```

   Or with options:
   ```bash
   npm start -- --playlists VIP,Mellow
   ```

5. Link globally (optional)
   ```bash
   npm link
   ```
   After linking, you can run the tool using the `aersia-hoshii` command from anywhere.

## Usage

### Basic Usage

To download all playlists:

```bash
npm start
```

Or if linked globally:
```bash
aersia-hoshii
```

### Command Line Options

```
Usage: aersia-hoshii [options]

Download tracks from Aersia playlists with resume capability

Options:
  -V, --version            output the version number
  -p, --playlists <playlists>  Comma-separated list of playlists to download (default: all)
  -c, --concurrent <number>    Maximum concurrent downloads (default: "3")
  -r, --rate <number>      Requests per minute (default: "30")
  -o, --output <path>      Output directory
  -l, --log-level <level>  Log level (debug, info, warn, error) (default: "info")
  --resume                 Resume previous download session
  --log-file <path>        Log to file
  --no-progress            Disable progress bar
  --config <path>          Path to config file
  -h, --help               display help for command
```

### Examples

Download only the VIP playlist:
```bash
npm start -- --playlists VIP
```

Download with 5 parallel downloads and custom output directory:
```bash
npm start -- --concurrent 5 --output ~/Music/Aersia
```

Resume a previous download session:
```bash
npm start -- --resume
```

### Executable Version

You can create a standalone executable version of the application using pkg:

```bash
# Install pkg globally
npm install -g pkg

# Create the executable
pkg .

# For Windows only
pkg . --targets node16-win-x64 --output aersia-downloader.exe
```

This creates an executable that can be run without installing Node.js.

## Configuration

You can create a `aersia-config.json` file in the current directory or specify a custom path with `--config`. Here's an example configuration:

```json
{
  "outputDir": "./Aersia Music",
  "maxConcurrentDownloads": 5,
  "requestsPerMinute": 40,
  "maxRetries": 10,
  "retryDelayMs": 2000,
  "progressUpdateIntervalMs": 300
}
```

## Default Output Location

By default, the application downloads files to the `./Aersia Playlists` directory in your current working directory, with subfolders for each playlist (VIP, Mellow, Exiled, WAP, CPP).

## Development

### Running in development mode

```bash
npm run dev
```

### Linting

```bash
npm run lint
```

### Cleaning build files

```bash
npm run clean
```

## License

ISC

## Acknowledgements

- [Aersia VGM](https://www.vipvgm.net/) for providing the awesome playlists
- Original Aersia-Hoshii script by tsuzushii
