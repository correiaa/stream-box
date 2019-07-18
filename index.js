process.on('unhandledRejection', (reason, p) => {
	console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

const { BrowserWindow, app, ipcMain } = require('electron');
const got = require('got');
const path = require('path');
const url = require('url');
const childProcess = require('child_process');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const { trakt, tmdb, justwatch } = require('./util');
const IMDBClient = require('./util/imdb');
const imdb = new IMDBClient();

let SCRAPE_PROCESS;
let LOCAL_RESOURCES_ROOT;
if (isDev()) {
	LOCAL_RESOURCES_ROOT = __dirname;
} else {
	LOCAL_RESOURCES_ROOT = `${__dirname}/../`;
}

const DATA_ROOT = app.getPath('userData').replace(/\\/g, '/');
const JUSTWATCH_GENRES = [
	'Action & Adventure',
	'Animation',
	'Comedy',
	'Crime',
	'Documentary',
	'Drama',
	'Fantasy',
	'History',
	'Horror',
	'Kids & Family',
	'Music & Musical',
	'Mystery & Thriller',
	'Romance',
	'Science-Fiction',
	'Sport & Fitness',
	'War & Military',
	'Western'
];

const seriesDataStorage = low(new FileSync(`${DATA_ROOT}/series-data.json`));
let ApplicationWindow;

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		app.quit(); // OSX
	}
});

app.on('ready', () => {
	ApplicationWindow = new BrowserWindow({
		title: 'Stream Box',
		icon: `${LOCAL_RESOURCES_ROOT}/icon.ico`,
		minHeight: '300px',
		minWidth: '500px',
		//fullscreen: true,
		webPreferences: {
			nodeIntegration: true
		}
	});

	if (!isDev()) {
		ApplicationWindow.setMenu(null);
	}
	ApplicationWindow.maximize();

	ApplicationWindow.webContents.on('did-finish-load', () => {
		ApplicationWindow.show();
		ApplicationWindow.focus();
	});

	ApplicationWindow.loadURL(url.format({
		pathname: path.join(__dirname, '/app/index.html'),
		protocol: 'file:',
		slashes: true
	}));

	ApplicationWindow.on('closed', () => {
		ApplicationWindow = null;
	});
});

ipcMain.on('initialize', async event => {
	event.sender.send('initializing');
	await initialize();
	event.sender.send('initialized');
});

ipcMain.on('ready', async event => {
	let trendingMovies = await trakt.trendingMovies();
	const popularMovies = await justwatch.getPopularMovies();
	const popularTVShows = await justwatch.getPopularTVShows();

	trendingMovies = await Promise.all(trendingMovies.map(async({ movie }) => {
		movie.images = await tmdb.movieImages(movie.ids.imdb);
		return movie;
	}));

	event.sender.send('update-home-carousel', trendingMovies);
	event.sender.send('update-home-popular-movies', popularMovies);
	event.sender.send('update-home-popular-tvshows', popularTVShows);
});

ipcMain.on('load-movie-details', async(event, id) => {
	const details = await justwatch.movieDetails(id);
	
	const related = await justwatch.relatedMedia(id, 'movie');

	const imdbId = (details.external_ids.find(id => id.provider === 'imdb')).external_id;

	const cast = (await imdb.cast(imdbId))
		.map(castMember => {
			const metadata = {
				name: castMember.name,
				characters: castMember.characters,
			};
			if (castMember.image) metadata.profile = castMember.image.url;

			return metadata;
		});

	event.sender.send('update-movie-details', {
		id,
		imdb_id: imdbId,
		media_type: details.object_type,
		title: details.title,
		age_rating: details.age_certification || 'Not Rated',
		runtime: details.runtime,
		genres: details.genre_ids.map(id => JUSTWATCH_GENRES[id - 1]),
		release_year: details.original_release_year,
		synopsis: details.short_description,
		cast,
		videos: details.clips,
		related_media: related,
		images: {
			backdrop: `https://images.justwatch.com${details.backdrops[0].backdrop_url.replace('{profile}', 's1440')}`,
			poster: `https://images.justwatch.com${details.poster.replace('{profile}', 's592')}`
		}
	});
});

ipcMain.on('load-show-details', async(event, {id, init}) => {
	let seasonDetails;
	let showDetails;

	if (init) {
		showDetails = await justwatch.showDetails(id);
		seasonDetails = await justwatch.seasonDetails(showDetails.seasons[0].id);
	} else {
		seasonDetails = await justwatch.seasonDetails(id);
		showDetails = await justwatch.showDetails(seasonDetails.show_id);
	}

	const imdbId = (showDetails.external_ids.find(id => id.provider === 'imdb')).external_id;
	const tmdbId = (showDetails.external_ids.find(id => id.provider === 'tmdb')).external_id;
	const lastWatched = seriesDataStorage.get(imdbId).toJSON();
	let lastWatchedData;

	if (!lastWatched) {
		lastWatchedData = {
			last_watched: {
				season: 1,
				episode: 1
			}
		};

		seriesDataStorage.set(imdbId, lastWatchedData).write();
	} else {
		lastWatchedData = lastWatched;
	}

	if (init) {
		const currentSeason = showDetails.seasons.find(({season_number}) => season_number === lastWatchedData.last_watched.season);

		seasonDetails = await justwatch.seasonDetails(currentSeason.id);
	} else {
		const oldData = seriesDataStorage.get(imdbId).toJSON();
		oldData.last_watched.season = seasonDetails.season_number;

		seriesDataStorage.get(imdbId).assign(oldData).write();
	}

	/*const episodeData = await imdb.episodes(imdbId);

	console.log(episodeData.seasons);
	console.log(seasonDetails.season_number);

	const seasons = episodeData.seasons.filter(({season}) => season);
	const season = seasons.find(({season}) => season === seasonDetails.season_number);

	const episodes = await Promise.all(season.episodes.map(async episode => ({
		number: episode.episode,
		season: episode.season,
		title: seasonDetails.episodes[episode.episode-1].title,
		screenshot: (await imdb._apiRequest(episode.id)).resource.image
	})));*/

	const episodes = seasonDetails.episodes.map(({title, episode_number}) => ({
		title,
		episode_number
	}));

	const extendedEpisodeData = await got.post('https://www.captainwatch.com/tvapi/episodes', {
		throwHttpErrors: false,
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
		},
		body: `movieId=${tmdbId}&seasonNumber=${seasonDetails.season_number}`
	}).then(({body, statusCode}) => (statusCode === 200 ? JSON.parse(body) : {}));

	if (extendedEpisodeData.episodes) {
		for (const episode of episodes) {
			const extended = extendedEpisodeData.episodes.find(({episode_number}) => episode_number === episode.episode_number);
			if (extended && extended.still) {
				episode.screenshot = extended.still;
			}
		}
	}

	const related = await justwatch.relatedMedia(showDetails.id, 'show');

	event.sender.send('update-show-details', {
		id,
		imdb_id: imdbId,
		media_type: 'show',
		title: showDetails.title,
		season_title: seasonDetails.title,
		age_rating: seasonDetails.age_certification || 'Not Rated',
		genres: seasonDetails.genre_ids.map(id => JUSTWATCH_GENRES[id - 1]),
		release_year: seasonDetails.original_release_year,
		synopsis: seasonDetails.short_description || showDetails.short_description,
		season: seasonDetails.season_number,
		seasons: showDetails.seasons,
		episodes,
		related_media: related,
		images: {
			backdrop: `https://images.justwatch.com${showDetails.backdrops[0].backdrop_url.replace('{profile}', 's1440')}`,
			poster: `https://images.justwatch.com${seasonDetails.poster.replace('{profile}', 's592')}`
		}
	});
});

ipcMain.on('search-media', async(event, {search_query, filters}) => {
	let results;
	switch (filters[0].value) { // content-type
		case 'all':
		default:
			results = await justwatch.searchAll(search_query);
			break;
		case 'movie':
			results = await justwatch.searchMovies(search_query);
			break;
		case 'show':
			results = await justwatch.searchShows(search_query);
			break;
	}

	event.sender.send('search-results', results);
});

ipcMain.on('scrape-streams', async(event, { id, season, episode }) => {
	// Using a child process here so that I can kill the entire scraping procress at once
	// This way any lingering requests or processing can all be killed at one time with no checks
	if (SCRAPE_PROCESS) {
		SCRAPE_PROCESS.kill();
	}

	const _arguments = [id, season, episode].filter(val => val);

	SCRAPE_PROCESS = childProcess.fork('./scrape.js', _arguments, {
		stdio: 'ignore'
	});

	SCRAPE_PROCESS.on('message', message => {
		if (message.event === 'stream') {
			event.sender.send('stream', message.data);
		} else if (message.event === 'finished') {
			if (!SCRAPE_PROCESS.killed) {
				SCRAPE_PROCESS.kill();
			}
		} else {
			throw new Error ('Unknown scrape process event', message.event);
		}
	});
});

async function initialize() {
	await imdb.temporaryCredentials();

	seriesDataStorage.defaults({}).write();
}

// https://github.com/electron/electron/issues/7714#issuecomment-255835799
function isDev() {
	return process.mainModule.filename.indexOf('app.asar') === -1;
}