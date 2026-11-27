// Entry point — mirrors main.go / zbridge.Run() in the Go original.
import { run } from './src/server.js';

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
