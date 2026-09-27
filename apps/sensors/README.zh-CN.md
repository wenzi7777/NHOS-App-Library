# 传感器示波器

实时图表显示 IMU、磁力计与电池读数。

这是一个读数面板：它在 Desktop 中运行，而不是在设备上。它每秒轮询设备的 `sensor_sample` 两次，以图表显示最近一分钟的加速度、角速度和磁场，并在旁边显示电池——与流程运算符 `imu()`、`mag()` 和 `battery()` 读取的数值相同。

**需要**：New Horizons OS v1.6.0 以及 New Horizons Desktop v0.13.0 或更新版本（图表组件）。

包文件为 [`readout.json`](readout.json)。
请在 New Horizons Desktop 的「应用」页面安装。

运算符参考与开销模型请参见[编写指南](../../docs/authoring.md)。
