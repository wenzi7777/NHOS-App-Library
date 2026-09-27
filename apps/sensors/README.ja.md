# センサースコープ

IMU・磁気センサー・電池の値をリアルタイムにグラフ表示。

リードアウトです。デバイス上ではなく Desktop で動作します。デバイスの `sensor_sample` を 1 秒に 2 回ポーリングし、直近 1 分間の加速度・回転・磁場をグラフ表示して、その横に電池残量を表示します。これらはフロー op の `imu()`、`mag()`、`battery()` が読み取るのと同じ値です。

**必要環境:** New Horizons OS v1.6.0 と New Horizons Desktop v0.13.0 以降（グラフウィジェットのため）。

パッケージは [`readout.json`](readout.json) です。
New Horizons Desktop の「アプリ」ページからインストールしてください。

op リファレンスとコストモデルについては、[作成ガイド](../../docs/authoring.md)を参照してください。
