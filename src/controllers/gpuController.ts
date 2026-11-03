import { app, ipcMain } from 'electron';
import { readFileSync, existsSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { getLogger } from '../utils/logger';
import { IPC_CHANNELS } from '../constants';
import { Renderer, VALID_RENDERERS } from "../interfaces/RendererTypes";

const logger = getLogger("GPUController");

function hasNvidiaVaapiSupport(): boolean {
    if (process.platform !== 'linux') return false;

    let nvidiaIsPrimary = false;
    try {
        const drmCards = readdirSync('/sys/class/drm').filter(entry => /^card\d+$/.test(entry));
        nvidiaIsPrimary = drmCards.some(card => {
            const devicePath = join('/sys/class/drm', card, 'device');
            try {
                const vendor = readFileSync(join(devicePath, 'vendor'), 'utf8').trim().toLowerCase();
                let bootVga = '';
                try {
                    bootVga = readFileSync(join(devicePath, 'boot_vga'), 'utf8').trim();
                } catch {
                    // Some single-GPU systems do not expose boot_vga.
                }

                const isPrimary = bootVga === '1' || (drmCards.length === 1 && bootVga === '');
                return vendor === '0x10de' && isPrimary;
            } catch {
                return false;
            }
        });
    } catch {
        return false;
    }

    if (!nvidiaIsPrimary) return false;

    const configuredVaapiDriverLocations = (process.env.LIBVA_DRIVERS_PATH || '')
        .split(':')
        .filter(Boolean)
        .map(path => join(path, 'nvidia_drv_video.so'));
    const vaapiDriverLocations = [
        ...configuredVaapiDriverLocations,
        '/usr/lib/dri/nvidia_drv_video.so',
        '/usr/lib64/dri/nvidia_drv_video.so',
        '/usr/lib/x86_64-linux-gnu/dri/nvidia_drv_video.so',
        '/usr/lib/aarch64-linux-gnu/dri/nvidia_drv_video.so'
    ];

    return vaapiDriverLocations.some(path => path !== '' && existsSync(path));
}

export const gpuController = {
    setup: (userDataPath: string) => {
        app.commandLine.appendSwitch('disable-features', 'UseChromeOSDirectVideoDecoder');

        let enabledFeatures = [
            'PlatformHEVCDecoderSupport',
            'AudioVideoTracks'
        ];

        const bootConfigPath = join(userDataPath, 'boot-config.json');
        let userRenderer: Renderer = 'auto';

        if (existsSync(bootConfigPath)) {
            try {
                const config = JSON.parse(readFileSync(bootConfigPath, 'utf-8'));
                if (VALID_RENDERERS.includes(config.renderer as typeof VALID_RENDERERS[number])) {
                    userRenderer = config.renderer as Renderer;
                } else if (config.renderer) {
                    logger.warn(`Invalid renderer '${config.renderer}' found in config. Defaulting to auto.`);
                }
            } catch (e) {
                logger.error("Failed to read boot config.");
            }
        }

        const nvidiaAutoDetected = userRenderer === 'auto' && hasNvidiaVaapiSupport();
        const effectiveRenderer: Renderer = nvidiaAutoDetected ? 'nvidia' : userRenderer;

        if (nvidiaAutoDetected) {
            logger.info('Auto-detected NVIDIA driver and VA-API driver; enabling NVIDIA video acceleration.');
        }

        if (effectiveRenderer === 'software') {
            logger.warn("User forced Software Rendering.");
            app.disableHardwareAcceleration();
            return;
        } else if(process.platform !== "darwin") { 
            // if not using software rendering and not on macOS, enable GPU related features
            logger.info("Enabling GPU features");
            enabledFeatures.push("AcceleratedVideoEncoder");
            app.commandLine.appendSwitch('ignore-gpu-blocklist');
            app.commandLine.appendSwitch('enable-zero-copy');
            app.commandLine.appendSwitch('enable-gpu-rasterization');
            app.commandLine.appendSwitch('enable-accelerated-video-decode');
        }

        if (process.platform === 'darwin') {
            // logger.info('Running on macOS, forcing Metal');
            // app.commandLine.appendSwitch('use-angle', 'metal');
            enabledFeatures.push("VideoToolboxVideoDecoder");
        } else if (process.platform === 'win32') {
            const renderer = effectiveRenderer === 'auto' || effectiveRenderer === 'nvidia' ? 'd3d11' : effectiveRenderer;
            logger.info(`Running on Windows, using ${renderer}`);

            app.commandLine.appendSwitch('use-angle', renderer);
            app.commandLine.appendSwitch('enable-gpu-rasterization');
            app.commandLine.appendSwitch('use-gl', 'angle');

            if (renderer === 'd3d11') enabledFeatures.push('D3D11VideoDecoder');
        } else {
            const renderer = effectiveRenderer === 'auto' || effectiveRenderer === 'nvidia' ? 'gl' : effectiveRenderer;
            logger.info(`Running on Linux, using ${renderer}`);

            app.commandLine.appendSwitch('use-angle', renderer);
            app.commandLine.appendSwitch('enable-gpu-rasterization');

            if (effectiveRenderer === 'nvidia') {
                // Chromium blocks VA-API on NVIDIA by default. The host must provide
                // libva-nvidia-driver (nvidia_drv_video.so) for this mode to work.
                logger.info('Configuring NVIDIA VA-API video acceleration');
                process.env.LIBVA_DRIVER_NAME ??= 'nvidia';
                process.env.NVD_BACKEND ??= 'direct';

                app.commandLine.appendSwitch('use-gl', 'angle');
                app.commandLine.appendSwitch('use-angle', 'gl');
                app.commandLine.appendSwitch('disable-gpu-driver-bug-workarounds');
                enabledFeatures.push(
                    'AcceleratedVideoDecodeLinuxGL',
                    'AcceleratedVideoDecodeLinuxZeroCopyGL',
                    'VaapiVideoDecoder',
                    'VaapiOnNvidiaGPUs',
                    'VaapiIgnoreDriverChecks',
                    'CanvasOopRasterization'
                );
            } else if (renderer === 'vulkan') {
                enabledFeatures.push(
                    'Vulkan',
                    'VaapiVideoDecoder',
                    'VaapiIgnoreDriverChecks',
                    'CanvasOopRasterization'
                );
            } else {
                enabledFeatures.push(
                    'VaapiVideoDecoder',
                    'VaapiVideoDecodeLinuxGL',
                    'CanvasOopRasterization'
                );
            }
        }

        app.commandLine.appendSwitch('enable-features', enabledFeatures.join(','));

        logger.info(`GPU setup complete. Renderer set to: ${effectiveRenderer}${nvidiaAutoDetected ? ' (auto-detected)' : ''}, Hardware Acceleration: ${app.isHardwareAccelerationEnabled() ? 'Enabled' : 'Disabled'}, Features: ${enabledFeatures.join(', ')}`);
    },

    initIPC: (userDataPath: string) => {
        const bootConfigPath = join(userDataPath, 'boot-config.json');

        ipcMain.handle(IPC_CHANNELS.SET_GPU_RENDERER, (_, selectedRenderer: string) => {
            let config: { renderer: string } = { renderer: 'auto' };

            if (existsSync(bootConfigPath)) {
                try {
                    const existingConfig = JSON.parse(readFileSync(bootConfigPath, 'utf-8'));
                    config = { ...config, ...existingConfig };
                } catch (e) {
                    logger.error("Failed to parse existing boot config during update.");
                }
            }

            config.renderer = VALID_RENDERERS.includes(selectedRenderer as typeof VALID_RENDERERS[number])
                ? selectedRenderer
                : 'auto';
            writeFileSync(bootConfigPath, JSON.stringify(config, null, 2));
            
            logger.info(`User updated GPU renderer to: ${selectedRenderer}. Requires restart.`);
            return true;
        });

        ipcMain.handle(IPC_CHANNELS.GET_GPU_RENDERER, (): Renderer => {
            if (!existsSync(bootConfigPath)) {
                writeFileSync(bootConfigPath, JSON.stringify({ renderer: "auto" }, null, 2));
                return "auto";
            }

            try {
                const rawData = readFileSync(bootConfigPath, 'utf-8');
                const configFile = JSON.parse(rawData);
                const savedRenderer = configFile?.renderer;

                if (VALID_RENDERERS.includes(savedRenderer as typeof VALID_RENDERERS[number])) {
                    return savedRenderer as Renderer;
                } else {
                    logger.warn(`Invalid renderer '${savedRenderer}' found in config. Defaulting to auto.`);
                    return "auto";
                }
            } catch (error) {
                logger.error(`Failed to read/parse boot config: ${(error as Error).message}`);
                return "auto"; 
            }
        });
    }
}
