const axiosLib = require('axios');
let axios = axiosLib.create();
const qs = require('qs')

const baseURL = 'https://my.tado.com/api/v2'
let log, storage, token, settings, homeId

const clientId = '1bb50063-6b0c-4d11-bd99-387f4a91cc46';
const deviceAuthURL = 'https://login.tado.com/oauth2/device_authorize';
const tokenURL = 'https://login.tado.com/oauth2/token';
const oauthScope = 'home.user offline_access';
const tokenStorageKey = 'tadoToken';
const pendingAuthStorageKey = 'tadoPendingDeviceAuth';
let pendingAuthInstructionsLogged = false;
let tokenRequestPromise = null;
let nextAllowedRequestAt = 0;

function parseRateLimitResetSeconds(headers) {
	if (!headers)
		return null

	const rateLimitHeader = headers.ratelimit || headers['ratelimit']
	if (!rateLimitHeader || typeof rateLimitHeader !== 'string')
		return null

	const match = rateLimitHeader.match(/t=(\d+)/)
	if (!match)
		return null

	const seconds = parseInt(match[1], 10)
	return Number.isNaN(seconds) ? null : seconds
}

function updateRateLimitWindowFromError(err) {
	if (!(err && err.response && err.response.status === 429))
		return

	const waitSeconds = parseRateLimitResetSeconds(err.response.headers)
	if (waitSeconds === null)
		return

	nextAllowedRequestAt = Date.now() + (waitSeconds * 1000)
	log(`tado° API rate limit reached. Backing off requests for ~${waitSeconds} seconds.`)
}

function assertWithinRateLimitWindow() {
	if (nextAllowedRequestAt > Date.now()) {
		const waitSeconds = Math.ceil((nextAllowedRequestAt - Date.now()) / 1000)
		throw new Error(`Tado API daily rate limit is active. Retry in about ${waitSeconds} seconds.`)
	}
}

module.exports = async function (platform) {
	log = platform.log
	storage = platform.storage

	const storageSettings = await storage.getItem('settings')
	if (storageSettings) {
		settings = storageSettings
		log.easyDebug(`Got settings from storage`)
	} else {
		settings = {}
	}

	axios.defaults.baseURL = baseURL
	
	if (platform.homeId)
		homeId = platform.homeId
	else {
		try {
			homeId = await get.HomeId()
		} catch(err) {
			log(`ERROR: Can't start the plugin without Home ID !!`)
			throw err
		}
	}
	
	return {
	
		getAllDevices: async () => {
			try {
				const temperatureUnit = await get.TemperatureUnit()
				const zones = await get.Zones()
				const installations = settings.installations || await get.Installations()

				const devices = zones.map(async zone => {
					let zoneState, capabilities
					try {
						zoneState = await get.State(zone.id)
						if (settings.capabilities && settings.capabilities[zone.id])
							capabilities = settings.capabilities[zone.id]
						else
							capabilities = await get.ZoneCapabilities(zone.id)
					} catch (err) {
						log(err)
						log(`COULD NOT get Zone ${zone.id} state and capabilities !! skipping device...`)
						return null
					}

					return {
						...zone,
						temperatureUnit: temperatureUnit,
						installation: installations[zone.id] || 'NON_THERMOSTATIC',
						capabilities: capabilities,
						state: zoneState,
						
					}
				})
				
				return await Promise.all(devices)
			} catch(err) {
				log(`Failed to get devices and states!!`)
				throw err
			}
		},
	
		setDeviceState: async (zoneId, overlay) => {
			const method = overlay ? 'put' : 'delete'
			const path = `/homes/${homeId}/zones/${zoneId}/overlay`
			return await setRequest(method, path, overlay)
		},

		getWeather: async () => {
			log.easyDebug(`Getting Weather Status from tado° API`)
			const path = `/homes/${homeId}/weather`
			try {
				const weather = await getRequest(path)
				weather.id = homeId
				settings.weather = weather
				storage.setItem('settings', settings)
				return weather
			} catch (err) {
				log.easyDebug(`The plugin was not able to retrieve Weather Status from tado° API !!`)
				if (settings.weather) {
					log.easyDebug(`Got Weather Status from storage  (NOT TO CRASH HOMEBRIDGE)  >>>`)
					log.easyDebug(JSON.stringify(settings.weather))
					return settings.weather
				}
				throw err
			}
		},

		getUsers: async () => {
			log.easyDebug(`Getting Users from tado° API`)
			const path = `/homes/${homeId}/users`
			try {
				const response = await getRequest(path)


				const users = response.filter(user => {
					user.trackedDevice = user.mobileDevices.find(device => device.settings.geoTrackingEnabled)
					return user.trackedDevice
				})

				settings.users = users
				log.easyDebug(`>>> Got Users from tado° API`)
				// log.easyDebug(JSON.stringify(users))
				storage.setItem('settings', settings)
				return users
			} catch (err) {
				log.easyDebug(`The plugin was not able to retrieve Users from tado° API !!`)
				if (settings.users) {
					log.easyDebug(`Got Users from storage  >>>`)
					log.easyDebug(JSON.stringify(settings.users))
					return settings.users
				}
				throw err
			}
		}
	}

}


function getDeviceCode() {
	return (async () => {
		const pendingAuth = await storage.getItem(pendingAuthStorageKey)
		if (pendingAuth && pendingAuth.device_code && pendingAuth.expirationDate > Date.now()) {
			if (!pendingAuthInstructionsLogged) {
				const authUrl = pendingAuth.verification_uri_complete || pendingAuth.verification_uri
				log('tado° authorization is pending.')
				if (authUrl)
					log(`Open this URL in a browser, sign in, and approve: ${authUrl}`)
				if (pendingAuth.user_code) {
					log(`If prompted, enter this user code: ${pendingAuth.user_code}`)
				}
				pendingAuthInstructionsLogged = true
			}

			return { device_code: pendingAuth.device_code }
		}

		const response = await axios.post(deviceAuthURL, qs.stringify({
			client_id: clientId,
			scope: oauthScope
		}))

		const authData = {
			device_code: response.data.device_code,
			user_code: response.data.user_code,
			verification_uri: response.data.verification_uri,
			verification_uri_complete: response.data.verification_uri_complete,
			interval: response.data.interval || 5,
			expirationDate: Date.now() + ((response.data.expires_in || 600) * 1000)
		}

		await storage.setItem(pendingAuthStorageKey, authData)

		log('tado° authorization required before the plugin can access your account.')
		log(`Open this URL in a browser, sign in, and approve: ${authData.verification_uri_complete || authData.verification_uri}`)
		if (authData.user_code) {
			log(`If prompted, enter this user code: ${authData.user_code}`)
		}
		log('After approval, restart Homebridge (or wait for the next refresh cycle).')
		pendingAuthInstructionsLogged = true

		return { device_code: authData.device_code, interval: authData.interval }
	})()
}

function readTokenFromStorage() {
	return storage.getItem(tokenStorageKey)
		.catch(error => {
			log.easyDebug('Error reading token from storage:', error)
			throw error
		})
}

function saveTokenToStorage(tokenData) {
	return storage.setItem(tokenStorageKey, tokenData)
		.then(() => {
			log.easyDebug('Token saved to storage.')
		})
		.catch(error => {
			log.easyDebug('Error saving token to storage:', error)
			throw error
		})
}

function shouldFallbackToDeviceAuth(err) {
	return Boolean(
		err &&
		err.response &&
		err.response.status === 400 &&
		err.response.data &&
		(
			err.response.data.error === 'invalid_grant' ||
			err.response.data.error === 'invalid_request' ||
			err.response.data.error_reason === 'missing_refresh_token'
		)
	)
}


async function requestToken() {
	const storedToken = await readTokenFromStorage()

	if (storedToken && storedToken.key && storedToken.expirationDate > Date.now()) {
		log.easyDebug('Using existing valid token from storage.')
		token = storedToken
		return storedToken.key
	}

	if (storedToken && storedToken.expirationDate <= Date.now() && storedToken.refresh_token) {
		log.easyDebug('Token expired, refreshing...')
		try {
			const refreshResponse = await axios.post(tokenURL, qs.stringify({
				client_id: clientId,
				grant_type: 'refresh_token',
				refresh_token: storedToken.refresh_token
			}))

			if (!refreshResponse.data.access_token) {
				throw new Error('Failed to refresh token')
			}

			const refreshedToken = {
				key: refreshResponse.data.access_token,
				expirationDate: Date.now() + refreshResponse.data.expires_in * 1000,
				// Some OAuth providers omit refresh_token on refresh. Keep the existing one in that case.
				refresh_token: refreshResponse.data.refresh_token || storedToken.refresh_token
			}

			await saveTokenToStorage(refreshedToken)
			token = refreshedToken
			return refreshedToken.key
		} catch (err) {
			if (shouldFallbackToDeviceAuth(err)) {
				log.easyDebug('Refresh token is not usable. Falling back to device authorization flow.')
				await storage.removeItem(tokenStorageKey).catch(() => null)
			} else {
				throw err
			}
		}
	} else if (storedToken && !storedToken.refresh_token) {
		log.easyDebug('Stored token has no refresh token. Starting device authorization flow.')
		await storage.removeItem(tokenStorageKey).catch(() => null)
	}

	log.easyDebug('No valid token, requesting a new one...')
	const deviceCodeData = await getDeviceCode()
	const response = await axios.post(tokenURL, qs.stringify({
		client_id: clientId,
		device_code: deviceCodeData.device_code,
		grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
		scope: oauthScope
	}))

	if (!response.data.access_token) {
		throw new Error('Token endpoint did not return an access token')
	}

	const newToken = {
		key: response.data.access_token,
		expirationDate: Date.now() + response.data.expires_in * 1000,
		refresh_token: response.data.refresh_token
	}

	await saveTokenToStorage(newToken)
	token = newToken
	await storage.removeItem(pendingAuthStorageKey).catch(() => null)
	return newToken.key
}

function getRequest(url) {
	return (async () => {
		let headers
		try {
			const tokenResponse = await getToken()
			headers = {
				'Authorization': 'Bearer ' + tokenResponse
			}
		} catch (err) {
			log('[GET] The plugin was NOT able to find stored token or acquire one from tado° API')
			throw err
		}

		log.easyDebug('Creating GET request to tado° API --->')
		log.easyDebug(baseURL + url)

		try {
			assertWithinRateLimitWindow()
			const response = await axios.get(url, { headers })
			const json = response.data
			log.easyDebug('Successful GET response:')
			log.easyDebug(JSON.stringify(json))
			return json
		} catch (err) {
			updateRateLimitWindowFromError(err)
			log(`ERROR: ${err.message}`)
			if (err.response) {
				log.easyDebug(err.response.data)
			}
			throw err
		}
	})()
}

function setRequest(method, url, data) {
	return (async () => {
		let headers
		try {
			const tokenResponse = await getToken()
			headers = {
				'Authorization': 'Bearer ' + tokenResponse
			}
		} catch (err) {
			log('[SET] The plugin was NOT able to find stored token or acquire one from tado° API ---> it will not be able to set the state !!')
			throw err
		}

		log.easyDebug(`Creating ${method.toUpperCase()} request to tado° API --->`)
		log.easyDebug(baseURL + url)
		if (data) {
			log.easyDebug('data: ' + JSON.stringify(data))
		}

		try {
			assertWithinRateLimitWindow()
			const response = await axios({url, data, method, headers})
			const json = response.data
			log.easyDebug(`Successful ${method.toUpperCase()} response:`)
			log.easyDebug(JSON.stringify(json))
			return json
		} catch (err) {
			updateRateLimitWindowFromError(err)
			log(`ERROR: ${err.message}`)
			if (err.response) {
				log.easyDebug(err.response.data)
			}
			throw err
		}
	})()
}

function getToken() {
	return (async () => {
		if (token && Date.now() < token.expirationDate) {
			return token.key
		}

		if (!tokenRequestPromise) {
			tokenRequestPromise = requestToken().finally(() => {
				tokenRequestPromise = null
			})
		}

		try {
			return await tokenRequestPromise
		} catch (err) {
			if (err.response && err.response.status === 400 && err.response.data && err.response.data.error === 'authorization_pending') {
				throw new Error('Authorization is pending. Approve the tado° device link in your browser first.')
			}
			if (err.response && err.response.status === 400 && err.response.data && err.response.data.error === 'expired_token') {
				await storage.removeItem(pendingAuthStorageKey).catch(() => null)
				throw new Error('Device authorization expired. Trigger a new authorization request by restarting Homebridge.')
			}

			log.easyDebug('Failed to get token')
			throw err
		}
	})()
}


const get = {
	HomeId: async () => {
		if (settings.homeId) {
			log.easyDebug(`Got Home ID from Storage  >>> ${settings.homeId} <<<`)
			return settings.homeId
		}

		log.easyDebug(`Getting Home ID from tado° API`)
		const path = '/me'
		try {
			const response = await getRequest(path)
			settings.homeId = response.homes[0].id
			log.easyDebug(`Got Home ID from tado° API  >>> ${settings.homeId} <<<`)
			storage.setItem('settings', settings)
			return settings.homeId
		} catch (err) {
			log.easyDebug(`The plugin was not able to retrieve Home ID from tado° API !!`)
			throw err
		}
	},


	TemperatureUnit: async () => {
		if (settings.temperatureUnit) {
			log.easyDebug(`Got Temperature Unit from Storage  >>> ${settings.temperatureUnit} <<<`)
			return settings.temperatureUnit
		}
			
		log.easyDebug(`Getting Temperature Unit from tado° API`)
		const path = `/homes/${homeId}`
		try {
			const response = await getRequest(path)
			settings.temperatureUnit = response.temperatureUnit
			log.easyDebug(`Got Temperature Unit from tado° API  >>> ${settings.temperatureUnit} <<<`)
			storage.setItem('settings', settings)
			return settings.temperatureUnit
		} catch (err) {
			log.easyDebug(`The plugin was not able to retrieve Temperature Unit from tado° API !! Using Celsius`)
			settings.temperatureUnit = 'CELSIUS'
			return settings.temperatureUnit
		}
	},

	Zones: async () => {
		log.easyDebug(`Getting Zones from tado° API`)
		const path = `/homes/${homeId}/zones`
		try {
			const response = await getRequest(path)
			const zones = response.filter(zone => zone.type === 'AIR_CONDITIONING')
			settings.zones = zones
			log.easyDebug(`>>> Got Zones from tado° API`)
			// log.easyDebug(JSON.stringify(zones))
			storage.setItem('settings', settings)
			return zones
		} catch (err) {
			log.easyDebug(`The plugin was not able to retrieve Zones from tado° API !!`)
			if (settings.zones) {
				log.easyDebug(`Got Zones from storage  >>>`)
				log.easyDebug(JSON.stringify(settings.zones))
				return settings.zones
			}
			throw err
		}
	},

	Installations: async () => {
		log.easyDebug(`Getting Installations from tado° API`)
		const path = `/homes/${homeId}/installations`
		try {
			const response = await getRequest(path)
			const installations = {}
			response.forEach(installation => {
				if (installation.acInstallationInformation) {
					const zoneId = installation.acInstallationInformation.createdZone.id
					installations[zoneId] = installation.acInstallationInformation.selectedSetupBranch
				}
			})

			settings.installations = installations
			log.easyDebug(`Got Installations from tado° API  >>>`)
			log.easyDebug(JSON.stringify(installations))
			storage.setItem('settings', settings)
			return installations
		} catch (err) {
			log(err)
			log.easyDebug(`The plugin was not able to retrieve Installations from tado° API !!`)
			if (settings.installations) {
				log.easyDebug(`Got Installations from storage  >>>`)
				log.easyDebug(JSON.stringify(settings.installations))
				return settings.installations
			}
			return false
		}
	},


	ZoneCapabilities: async (zoneId) => {
		log.easyDebug(`Getting Zone Capabilities from tado° API`)
		const path = `/homes/${homeId}/zones/${zoneId}/capabilities`
		try {
			const capabilities = await getRequest(path)
			log.easyDebug(`>>> Got Zone ${zoneId} Capabilities from tado° API`)
			// log.easyDebug(JSON.stringify(capabilities))

			if (!settings.capabilities)
				settings.capabilities = {}

			settings.capabilities[zoneId] = capabilities
			storage.setItem('settings', settings)
			return capabilities
		} catch (err) {
			log.easyDebug(`The plugin was not able to retrieve Zone ${zoneId} Capabilities from tado° API !!`)
			if (settings.capabilities && settings.capabilities[zoneId]) {
				log.easyDebug(`Got Zone ${zoneId} Capabilities from storage  >>>`)
				log.easyDebug(JSON.stringify(settings.capabilities[zoneId]))
				return settings.capabilities[zoneId]
			}
			throw err
		}
	},

	State: async (zoneId) => {
		log.easyDebug(`Getting Zone state from tado° API`)
		const path = `/homes/${homeId}/zones/${zoneId}/state`
		try {
			const state = await getRequest(path)
			log.easyDebug(`>>> Got Zone ${zoneId} state from tado° API  >>>`)
			// log.easyDebug(JSON.stringify(state))

			if (!settings.states)
				settings.states = {}

			settings.states[zoneId] = state
			storage.setItem('settings', settings)
			return state
		} catch (err) {
			log.easyDebug(`The plugin was not able to retrieve Zone ${zoneId} state from tado° API !!`)
			if (settings.states && settings.states[zoneId]) {
				log.easyDebug(`Got Zone ${zoneId} state from storage  (NOT TO CRASH HOMEBRIDGE) >>>`)
				log.easyDebug(JSON.stringify(settings.states[zoneId]))
				return settings.states[zoneId]
			}
			throw err
		}
	}
}
