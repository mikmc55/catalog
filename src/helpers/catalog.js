const { pool } = require('./db');
const { discoverContent, makeRequest } = require('../api/tmdb');
const { getFanartPoster } = require('../api/fanart');
const { getCachedPoster, setCachedPoster } = require('./cache');
const cloudStorage = require('../services/cloud-storage');
const log = require('./logger');
const axios = require('axios');
const path = require('path');

const baseUrl = process.env.BASE_URL || 'http://localhost:7000';

async function parseConfigParameters(configParameters) {
    let parsedConfig = {};
    if (configParameters) {
        try {
            parsedConfig = JSON.parse(decodeURIComponent(configParameters));
        } catch (error) {
            log.error(`Error parsing configParameters: ${error.message}`);
        }
    }
    return parsedConfig;
}

function extractCatalogInfo(id) {
    const match = id.match(/^tmdb-discover-(movies|series)(-new|-popular)?-(\d+)$/);
    if (!match) {
        throw new Error('Invalid catalog id');
    }
    return {
        catalogType: match[1],
        providerId: parseInt(match[3], 10)
    };
}

async function getGenreId(genreName, type) {
    try {
        const result = await pool.query(
            "SELECT genre_id FROM genres WHERE genre_name = $1 AND media_type = $2", 
            [genreName, type === 'series' ? 'tv' : 'movie']
        );
        const row = result.rows[0];
        return row ? row.genre_id : null;
    } catch (err) {
        throw err;
    }
}

async function fetchDiscoverContent(catalogType, providers, ageRange, sortBy, genre, tmdbApiKey, language, skip, regions, year = null, rating = null) {
    return await discoverContent(catalogType, providers, ageRange, sortBy, genre, tmdbApiKey, language, skip, regions, year, rating);
}

function getRpdbPoster(type, id, language, rpdbkey) {
    const tier = rpdbkey.split("-")[0];
    const lang = language.split("-")[0];
    const baseUrl = `https://api.ratingposterdb.com/${rpdbkey}/tmdb/poster-default/${type}-${id}.jpg?fallback=true`;
    return (tier === "t0" || tier === "t1") ? baseUrl : `${baseUrl}&lang=${lang}`;
}

async function getPosterUrl(content, catalogType, language, rpdbApiKey) {
    if (!content.poster_path) return null;
    
    // If using RPDB, use existing logic
    if (rpdbApiKey) {
        const posterId = `poster:${content.id}`;
        const cachedPoster = await getCachedPoster(posterId);
        if (cachedPoster) {
            log.debug(`Using cached poster URL for id ${posterId}`);
            return cachedPoster.poster_url;
        }

        const rpdbImage = getRpdbPoster(catalogType, content.id, language, rpdbApiKey);
        try {
            const response = await axios.head(rpdbImage);
            if (response.status === 200) {
                log.debug(`RPDB poster found for id ${posterId}`);
                await setCachedPoster(posterId, rpdbImage);
                return rpdbImage;
            }
        } catch (error) {
            log.warn(`Error fetching RPDB poster: ${error.message}. Falling back to TMDB poster with rating.`);
        }
    }

    // TMDB fallback URL
    const tmdbFallbackUrl = `https://image.tmdb.org/t/p/w500${content.poster_path}`;

    // Format rating to one decimal place
    const rating = content.vote_average ? parseFloat(content.vote_average).toFixed(1) : 'NR';
    const contentId = `${content.id}-${rating}`;

    try {
        // Check if rated poster exists in cloud storage
        const cloudUrl = await cloudStorage.getPosterUrl(contentId);
        if (cloudUrl) {
            log.debug(`Using existing cloud poster for ${contentId}`);
            return cloudUrl;
        }

        // If not found, create and upload it
        try {
            const response = await axios.post(`${baseUrl}/cache-rated-poster`, {
                posterUrl: tmdbFallbackUrl,
                rating: rating,
                contentId: contentId
            });

            if (response.data.success && response.data.url) {
                log.debug(`Created new cloud poster for ${contentId}`);
                return response.data.url;
            }
        } catch (error) {
            log.error(`Failed to create/upload rated poster for ${contentId}: ${error.message}`);
            return tmdbFallbackUrl;
        }

        return tmdbFallbackUrl;
    } catch (error) {
        log.error(`Error handling poster for ${contentId}: ${error.message}`);
        return tmdbFallbackUrl;
    }
}

async function getGenreName(genreId, type, language) {
    try {
        const result = await pool.query(
            "SELECT genre_name FROM genres WHERE genre_id = $1 AND media_type = $2 AND language = $3", 
            [genreId, type === 'series' ? 'tv' : 'movie', language]
        );
        const row = result.rows[0];
        return row ? row.genre_name : null;
    } catch (err) {
        throw err;
    }
}

async function buildMetas(filteredResults, catalogType, language, rpdbApiKey, fanartApiKey, addWatchedTraktBtn, hideTraktHistory, traktUsername, origin, tmdbApiKey = null) {
    try {
        return await Promise.all(filteredResults.map(async (content) => {
            try {
                const posterUrl = await getPosterUrl({ 
                    id: content.id, 
                    poster_path: content.poster_path,
                    vote_average: content.vote_average 
                }, catalogType, language, rpdbApiKey);

                let logo = null;
                if (fanartApiKey) {
                    logo = await getFanartPoster(content.id, language, fanartApiKey);
                }

                let imdbId = null;
                if (tmdbApiKey) {
                    try {
                        const externalIds = await makeRequest(
                            `https://api.themoviedb.org/3/${catalogType === 'series' ? 'tv' : 'movie'}/${content.id}/external_ids`,
                            tmdbApiKey
                        );
                        imdbId = externalIds.imdb_id;
                    } catch (error) {
                        log.error(`Error fetching external IDs for TMDB ID ${content.id}: ${error.message}`);
                    }
                }

                const releaseDate = catalogType === 'movies' ? content.release_date : content.first_air_date;
                const releaseInfo = releaseDate ? releaseDate.split('-')[0] : '';

                const links = [];
                if (addWatchedTraktBtn && hideTraktHistory === 'true' && traktUsername) {
                    links.push({
                        name: addWatchedTraktBtn,
                        category: 'Trakt',
                        url: `${origin}/updateWatched/${traktUsername}/${catalogType}/${content.id}`
                    });
                }

                let metaId = imdbId || `tmdb:${content.id}`;

                return {
                    id: metaId,
                    type: catalogType === 'movies' ? 'movie' : 'series',
                    name: catalogType === 'movies' ? content.title : content.name,
                    poster: posterUrl,
                    background: content.backdrop_path ? `https://image.tmdb.org/t/p/w1280${content.backdrop_path}` : null,
                    logo: logo || null,
                    description: content.overview,
                    releaseInfo: releaseInfo,
                    imdbRating: content.vote_average ? parseFloat(content.vote_average).toFixed(1) : null,
                    genres: content.genre_ids ? await Promise.all(
                        content.genre_ids.map(async (genreId) => {
                            const genreName = await getGenreName(genreId, catalogType, language);
                            return genreName;
                        })
                    ).then(genres => genres.filter(Boolean)) : [],
                    links: links.length > 0 ? links : undefined,
                    behaviorHints: {
                        defaultVideoId: imdbId || `tmdb:${content.id}`
                    }
                };
            } catch (error) {
                log.error(`Error processing content item ${content.id}: ${error.message}`);
                return null;
            }
        })).then(results => results.filter(Boolean));
    } catch (error) {
        log.error(`Error in buildMetas: ${error.message}`);
        throw error;
    }
}

module.exports = {
    parseConfigParameters,
    extractCatalogInfo,
    getGenreId,
    fetchDiscoverContent,
    getPosterUrl,
    buildMetas
};