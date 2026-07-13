import { defineAgent } from '@mosaic/agent-sdk';

export default defineAgent(async (mosaic) => {
    await mosaic.log.emit({ message: 'compiled' });
});
