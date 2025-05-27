import {
    API,
    DynamicPlatformPlugin,
    Logger,
    PlatformAccessory,
    PlatformConfig,
    Service,
    Characteristic
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { axiosAppliance, axiosAuth } from './services/axios';
import { Appliances } from './definitions/appliances';
import { DEVICES } from './const/devices';
import { TokenResponse } from './definitions/auth';
import { ElectroluxAccessory } from './accessories/accessory';
import { Capabilities } from './definitions/capabilities';
import { Context } from './definitions/context';

/*
    HomebridgePlatform
    This class is the main constructor for your plugin, this is where you should
    parse the user config and discover/register accessories with Homebridge.
*/
export class ElectroluxDevicesPlatform implements DynamicPlatformPlugin {
    public readonly Service: typeof Service = this.api.hap.Service;
    public readonly Characteristic: typeof Characteristic =
        this.api.hap.Characteristic;

    public readonly accessories: ElectroluxAccessory[] = [];

    accessToken: string | null = null;
    private refreshToken: string | null = null;
    tokenExpirationDate: number | null = null;

    regionalBaseUrl: string | null = null;

    private devicesDiscovered = false;
    private pollingInterval: NodeJS.Timeout | null = null;

    constructor(
        public readonly log: Logger,
        public readonly config: PlatformConfig,
        public readonly api: API
    ) {
        this.log.debug('Finished initializing platform:', this.config.name);

        // When this event is fired it means Homebridge has restored all cached accessories from disk.
        // Dynamic Platform plugins should only register new accessories after this event was fired,
        // in order to ensure they weren't added to homebridge already. This event can also be used
        // to start discovery of new accessories.
        this.api.on('didFinishLaunching', async () => {
            try {
                if (!this.config.refreshToken) {
                    await this.signIn();
                } else {
                    this.refreshToken = this.config.refreshToken;
                    await this.refreshAccessToken();
                }

                // run the method to discover / register your devices as accessories
                await this.discoverDevices();
            } catch (err) {
                this.log.warn((err as Error).message);
            } finally {
                this.pollingInterval = setInterval(
                    this.pollStatus.bind(this),
                    (this.config.pollingInterval || 10) * 1000
                );
            }
        });

        this.api.on('shutdown', async () => {
            if (this.pollingInterval) {
                clearInterval(this.pollingInterval);
            }
        });
    }

    /*
        This function is invoked when homebridge restores cached accessories from disk at startup.
        It should be used to setup event handlers for characteristics and update respective values.
    */
    configureAccessory(accessory: PlatformAccessory<Context>) {
        this.log.info('Loading accessory from cache:', accessory.displayName);

        // add the restored accessory to the accessories cache so we can track if it has already been registered
        this.accessories.push(new ElectroluxAccessory(accessory));
    }

    async signIn() {
        /* 
            Get the token from Electrolux API using CLIENT_ID and CLIENT_SECRET 
            to fetch the regional base URL and API key.
        */
        this.log.info('one-account-authorization');

        this.accessToken =
            'Bearer eyJraWQiOiIxMGZhMWQwOWY4YjM2OGFjYmE4YmRiNDYxOTFmZmVhODE1MmZiM2YzZjQ5N2RhZjk1OWFjNWIzNDM5ZDI3OGY0IiwiYWxnIjoiUlMyNTYiLCJ0eXAiOiJKV1QifQ.eyJpYXQiOjE3NDgzNTYxMjksImlzcyI6Imh0dHBzOi8vYXBpLm9jcC5lbGVjdHJvbHV4Lm9uZS9vbmUtYWNjb3VudC1hdXRob3JpemF0aW9uIiwiYXVkIjpbImh0dHBzOi8vYXBpLm9jcC5lbGVjdHJvbHV4Lm9uZSIsImVsZWN0cm9sdXhfb2NwIl0sImV4cCI6MTc0ODM5OTMyOSwic3ViIjoiY2NjYTBiNzliMjE5NDUyOWE0MTA2YmNkODBlNTAxZTYiLCJhenAiOiJIZWlPcGVuQXBpIiwic2NvcGUiOiJlbWFpbCBvZmZsaW5lX2FjY2VzcyIsIm9jYyI6IkhVIn0.pXRmxbBBfhjARCNfAJj3YOvpZj6hm66cjdLiw55W-YJtudkruxmX8EmpUxwkdGREzKENPUzg1DF1HOZ4Uajyd05SKbR74Kbtm9ZL6ytr7_tOm_TnQQEk65v2VuEPv4BhJmXAObTOXi3SKZ8W6thQduPhqnfrYt-Q49gBlBZ8GCvvhgRA6070iEvzVjuz6E2IZ4_H0fqhR3zNAQ_ZbRgxuJdz4AwfJo3W30cKiVJens4nLtVWKZ889-D2b0GUmiRH1dyhpg1AnNmKQGSISCvphJPv1HVzBWhgf3h4mfyDXT4lGhMoYHZ8flS7rfjF3pqHDdGXKaHUz_mHGn4JbX932w';
        this.refreshToken =
            'fWAXEydextaI2b18bTyO8rIQ7r8inT9lvnfBnG1IpmBXn5P6lKc1fYRq7QOmeD2H9xDg558UNJtRjKu6qA2KCN7giCkn3HPRHC4Rfiimhl3l5uowUyk0rVuyDipLrYq0';

        this.regionalBaseUrl = 'https://api.developer.electrolux.one';
    }

    async refreshAccessToken() {
        if (!this.refreshToken) {
            return;
        }

        this.log.info('Refreshing access token...');

        const response = await axiosAuth.post<TokenResponse>(
            '/refresh',
            {
                grantType: 'refresh_token',
                refreshToken: this.refreshToken
            },
            {
                baseURL: `${this.regionalBaseUrl}/api/v1/token`
            }
        );

        this.accessToken = response.data.accessToken;
        this.refreshToken = response.data.refreshToken;
        this.tokenExpirationDate = Date.now() + response.data.expiresIn * 1000;

        this.log.info('Access token refreshed!');
    }

    private async getAppliances() {
        const response = await axiosAppliance.get<Appliances>('/appliances', {
            baseURL: `${this.regionalBaseUrl}/api/v1`,
            headers: {
                Authorization: `Bearer ${this.accessToken}`
            }
        });
        return response.data;
    }

    async getApplianceCapabilities(
        applianceId: string
    ): Promise<Capabilities | null> {
        try {
            const response = await axiosAppliance.get<Capabilities>(
                `/appliances/${applianceId}/info`,
                {
                    baseURL: `${this.regionalBaseUrl}/api/v1`,
                    headers: {
                        Authorization: `Bearer ${this.accessToken}`
                    }
                }
            );

            return response.data;
        } catch (err) {
            return null;
        }
    }

    /*
        Get the appliances from the Electrolux API and register each appliance as an accessory.
    */
    async discoverDevices() {
        if (!this.accessToken) {
            return;
        }

        this.log.info('Discovering devices...');

        const appliances = await this.getAppliances();

        appliances.map(async (appliance) => {
            if (!DEVICES[appliance.applianceData.modelName]) {
                this.log.warn(
                    'Accessory not found for model: ',
                    appliance.applianceData.modelName
                );
                return;
            }

            const uuid = this.api.hap.uuid.generate(appliance.applianceId);

            const existingAccessory = this.accessories.find(
                (accessory) => accessory.platformAccessory.UUID === uuid
            );

            /* 
                Get the capabilities of the appliance from the context.
                If the capabilities are not in the context, fetch them from the API.
                If the capabilities equals null, that means the appliance capabilities is not supported.
            */
            const capabilities =
                existingAccessory?.platformAccessory.context.capabilities !==
                undefined
                    ? existingAccessory.platformAccessory.context.capabilities
                    : await this.getApplianceCapabilities(
                          appliance.applianceId
                      );

            if (existingAccessory) {
                this.log.info(
                    'Restoring existing accessory from cache:',
                    existingAccessory.platformAccessory.displayName
                );
                existingAccessory.controller = new DEVICES[
                    appliance.applianceData.modelName
                ](
                    this,
                    existingAccessory.platformAccessory,
                    appliance,
                    capabilities
                );
                return;
            }

            this.log.info(
                'Adding new accessory:',
                appliance.applianceData.applianceName
            );

            const platformAccessory = new this.api.platformAccessory(
                appliance.applianceData.applianceName,
                uuid
            );
            const accessory = new ElectroluxAccessory(
                platformAccessory,
                new DEVICES[appliance.applianceData.modelName](
                    this,
                    platformAccessory,
                    appliance,
                    capabilities
                )
            );
            this.accessories.push(accessory);

            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
                platformAccessory
            ]);
        });

        this.log.info('Devices discovered!');
        this.devicesDiscovered = true;
    }

    async pollStatus() {
        try {
            if (
                !this.tokenExpirationDate ||
                Date.now() >= this.tokenExpirationDate
            ) {
                await this.refreshAccessToken();
            }

            if (!this.devicesDiscovered) {
                await this.discoverDevices();
                return;
            }

            this.log.debug('Polling appliances status...');

            const appliances = await this.getAppliances();

            appliances.map((appliance) => {
                const uuid = this.api.hap.uuid.generate(appliance.applianceId);

                const existingAccessory = this.accessories.find(
                    (accessory) => accessory.platformAccessory.UUID === uuid
                );
                if (!existingAccessory) {
                    return;
                }

                existingAccessory.controller?.update(appliance);
            });

            this.log.debug('Appliances status polled!');
        } catch (err) {
            const message =
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (err as any).response?.data?.message ?? (err as Error).message;

            this.log.warn('Polling error: ', message);
        }
    }
}
