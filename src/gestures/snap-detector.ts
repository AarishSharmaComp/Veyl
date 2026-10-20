export class SnapDetector {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private frequencyData: Uint8Array<ArrayBuffer> | null = null;
  private baseline = 0.035;
  private lastSnapAt = 0;
  private sensitivity = 0.62;
  private callback: (() => void) | null = null;

  async start(sensitivity: number, callback: () => void): Promise<void> {
    await this.stop();
    this.sensitivity = sensitivity;
    this.baseline = 0.035;
    this.lastSnapAt = 0;
    this.callback = callback;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: false,
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1
        },
        video: false
      });

      const AudioContextConstructor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextConstructor) throw new Error('This browser does not expose the Web Audio API.');

      this.context = new AudioContextConstructor();
      await this.context.resume();
      const source = this.context.createMediaStreamSource(this.stream);
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.smoothingTimeConstant = 0.16;
      this.frequencyData = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
      this.processor = this.context.createScriptProcessor(1024, 1, 1);
      this.processor.onaudioprocess = (event) => {
        for (let channel = 0; channel < event.outputBuffer.numberOfChannels; channel += 1) {
          event.outputBuffer.getChannelData(channel).fill(0);
        }
        this.inspect();
      };
      source.connect(this.analyser);
      this.analyser.connect(this.processor);
      // A ScriptProcessor is only scheduled while connected to the graph. Its output is empty.
      this.processor.connect(this.context.destination);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  setSensitivity(value: number): void {
    this.sensitivity = Math.min(1, Math.max(0, value));
  }

  private inspect(): void {
    if (!this.analyser || !this.frequencyData) return;
    this.analyser.getByteFrequencyData(this.frequencyData);
    const midpoint = Math.floor(this.frequencyData.length * 0.34);
    let total = 0;
    let high = 0;
    for (let index = 0; index < this.frequencyData.length; index += 1) {
      const energy = this.frequencyData[index] / 255;
      total += energy;
      if (index >= midpoint) high += energy;
    }
    total /= this.frequencyData.length;
    high /= Math.max(1, this.frequencyData.length - midpoint);
    this.baseline = this.baseline * 0.965 + total * 0.035;

    const now = performance.now();
    const threshold = 0.12 - this.sensitivity * 0.055;
    const transient = total - this.baseline;
    const isSnap = total > threshold && transient > threshold * 0.4 && high > 0.095;
    if (isSnap && now - this.lastSnapAt > 720) {
      this.lastSnapAt = now;
      this.callback?.();
    }
  }

  async stop(): Promise<void> {
    this.processor?.disconnect();
    this.analyser?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.processor = null;
    this.analyser = null;
    this.frequencyData = null;
    this.callback = null;
    const context = this.context;
    this.context = null;
    this.stream = null;
    if (context && context.state !== 'closed') await context.close();
  }

  get active(): boolean {
    return Boolean(this.stream && this.context && this.context.state !== 'closed');
  }
}
