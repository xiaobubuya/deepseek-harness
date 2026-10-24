// Vault module - stub
export async function initVault(env) { /* no-op */ }
export async function getVaultSecret(provider, request, ctx, env, cors) { return { error: 'not_implemented' }; }
export async function putVaultSecret(provider, request, env, cors) { return { error: 'not_implemented' }; }
export async function deleteVaultSecret(provider, request, env, cors) { return { error: 'not_implemented' }; }
export async function listVaultSecrets(env, cors) { return { secrets: {} }; }
