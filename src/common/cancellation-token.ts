export class CancellationToken {
    private isCancelled = false;

    cancel() {
        this.isCancelled = true;
    }

    get cancelled() {
        return this.isCancelled;
    }
}