// Compose an H.264/AAC MP4 from a PNG frame sequence and a WAV narration track (AVFoundation only).
// usage: swift compose.swift <framesDir> <fps> <narration.wav> <out.mp4>
import AVFoundation
import CoreGraphics
import ImageIO
import Foundation

let args = CommandLine.arguments
guard args.count == 5 else { print("usage: compose <framesDir> <fps> <narration.wav> <out.mp4>"); exit(2) }
let framesDir = URL(fileURLWithPath: args[1]), fps = Int32(args[2])!, wav = URL(fileURLWithPath: args[3]), out = URL(fileURLWithPath: args[4])
let frames = try FileManager.default.contentsOfDirectory(atPath: framesDir.path).filter { $0.hasSuffix(".png") || $0.hasSuffix(".jpg") }.sorted()
guard let first = CGImageSourceCreateWithURL(framesDir.appendingPathComponent(frames[0]) as CFURL, nil), let img0 = CGImageSourceCreateImageAtIndex(first, 0, nil) else { print("no frames"); exit(1) }
let W = img0.width, H = img0.height
try? FileManager.default.removeItem(at: out)
let writer = try AVAssetWriter(outputURL: out, fileType: .mp4)
let vIn = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: W, AVVideoHeightKey: H,
  AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 2_500_000, AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel]])
vIn.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: vIn, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB, kCVPixelBufferWidthKey as String: W, kCVPixelBufferHeightKey as String: H])
let aIn = AVAssetWriterInput(mediaType: .audio, outputSettings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44100, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 96_000])
aIn.expectsMediaDataInRealTime = false
writer.add(vIn); writer.add(aIn)
let asset = AVURLAsset(url: wav)
let reader = try AVAssetReader(asset: asset)
let track = try await asset.loadTracks(withMediaType: .audio)[0]
let aOut = AVAssetReaderTrackOutput(track: track, outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 44100, AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false])
reader.add(aOut)
writer.startWriting(); reader.startReading(); writer.startSession(atSourceTime: .zero)
let group = DispatchGroup()
group.enter()
var i = 0
vIn.requestMediaDataWhenReady(on: DispatchQueue(label: "v")) {
  while vIn.isReadyForMoreMediaData {
    if i >= frames.count { vIn.markAsFinished(); group.leave(); return }
    autoreleasepool {
      let src = CGImageSourceCreateWithURL(framesDir.appendingPathComponent(frames[i]) as CFURL, nil)!
      let img = CGImageSourceCreateImageAtIndex(src, 0, nil)!
      var pb: CVPixelBuffer?
      CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pb)
      CVPixelBufferLockBaseAddress(pb!, [])
      let ctx = CGContext(data: CVPixelBufferGetBaseAddress(pb!), width: W, height: H, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(pb!), space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue)!
      ctx.draw(img, in: CGRect(x: 0, y: 0, width: W, height: H))
      CVPixelBufferUnlockBaseAddress(pb!, [])
      adaptor.append(pb!, withPresentationTime: CMTime(value: CMTimeValue(i), timescale: fps))
    }
    i += 1
  }
}
group.enter()
aIn.requestMediaDataWhenReady(on: DispatchQueue(label: "a")) {
  while aIn.isReadyForMoreMediaData {
    if let sb = aOut.copyNextSampleBuffer() { aIn.append(sb) } else { aIn.markAsFinished(); group.leave(); return }
  }
}
group.wait()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
print(writer.status == .completed ? "wrote \(out.path) (\(frames.count) frames @ \(fps) fps)" : "failed: \(String(describing: writer.error))")
exit(writer.status == .completed ? 0 : 1)
