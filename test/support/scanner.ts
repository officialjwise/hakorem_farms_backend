import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

/**
 * ClamAV's daemon, the malware scanner of every environment (A-057, ADR-0044), with the signatures its image ships
 * and no update on start, so a test run needs no network. Started by the specs that scan, not by every run: it
 * takes a gigabyte of memory and up to a minute to load its signatures.
 */
export const SCANNER_IMAGE = 'clamav/clamav:1.4.3';
export const SCANNER_PORT = 3310;
const SCANNER_STARTUP_MS = 170_000;

export function startScanner(): Promise<StartedTestContainer> {
  return new GenericContainer(SCANNER_IMAGE)
    .withEnvironment({ CLAMAV_NO_FRESHCLAMD: 'true' })
    .withExposedPorts(SCANNER_PORT)
    .withWaitStrategy(Wait.forLogMessage('socket found, clamd started'))
    .withStartupTimeout(SCANNER_STARTUP_MS)
    .start();
}

/** The EICAR test file: every scanner reports it, and it is harmless. */
export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
