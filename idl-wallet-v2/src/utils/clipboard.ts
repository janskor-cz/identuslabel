/**
 * Clipboard utility functions with fallback support
 * Handles clipboard operations across different browser environments
 */

/**
 * Copy text to clipboard with fallback for older browsers or HTTP contexts
 * @param text - Text to copy to clipboard
 * @returns Promise that resolves when copy is successful
 */
export async function copyToClipboard(text: string): Promise<void> {
    try {
        // Check if navigator.clipboard is available (modern browsers with HTTPS)
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return;
        }

        // Fallback for older browsers or HTTP contexts
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        textArea.style.top = '-999999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();

        try {
            const successful = document.execCommand('copy');
            if (!successful) {
                throw new Error('document.execCommand("copy") failed');
            }
        } finally {
            document.body.removeChild(textArea);
        }
    } catch (error) {
        console.error('Failed to copy text to clipboard:', error);
        // Show user feedback that copy failed
        alert('Copy failed. Please copy the text manually.');
        throw error;
    }
}

/**
 * Copy text with user feedback logging
 * @param text - Text to copy
 * @param label - Label for logging purposes
 * @returns Promise that resolves when copy is successful
 */
export async function copyToClipboardWithLog(text: string, label: string): Promise<void> {
    try {
        await copyToClipboard(text);
        console.log(`${label} copied to clipboard`);
    } catch (error) {
        console.error(`Failed to copy ${label}:`, error);
        throw error;
    }
}